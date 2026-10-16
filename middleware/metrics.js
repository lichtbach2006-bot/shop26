/**
 * Lightweight server-side performance instrumentation.
 *
 *  - requestMetrics : Express middleware that times every request.
 *  - recordError    : call from the global error handler to log unhandled errors.
 *  - Mongoose plugin: times Model queries / aggregations / saves.
 *
 * To keep overhead low nothing is written per request. Samples are aggregated in
 * memory into 10-minute buckets and flushed to MongoDB (collection `perfmetrics`)
 * every 30 seconds with a single bulkWrite. No request bodies, query strings,
 * headers, cookies or user data are ever recorded, and error messages are
 * sanitised and truncated.
 *
 * IMPORTANT: this file must be required BEFORE any model is compiled, because
 * the Mongoose plugin only attaches to models created after it is registered.
 */
const mongoose = require("mongoose");
const PerfMetric = require("../models/PerfMetric"); // compiled before the plugin => never self-instrumented

const BUCKET_MS = 10 * 60 * 1000;
const FLUSH_MS = 30 * 1000;
const MAX_KEYS = 2000; // cap on in-memory buckets between flushes
const MAX_ERRORS = 100; // cap on in-memory error docs between flushes
const SLOW_API_MS = 1000;
const SLOW_DB_MS = 100;

const buffer = new Map();
let errorBuffer = [];
let flushing = false;
const startedAt = new Date();

// ---------------------------------------------------------------- helpers
function sanitize(message) {
  return String(message || "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]") // emails
    .replace(/(password|passwd|token|secret|authorization|cookie|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\b[A-Fa-f0-9]{24,}\b/g, "[id]") // ObjectIds / hashes
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, "[redacted]") // long token-like strings
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function categorize(err) {
  const name = (err && err.name) || "";
  if (name === "ValidationError") return "validation";
  if (name === "CastError") return "bad_input";
  if (name === "MulterError") return "upload";
  if (/^Mongo|^Mongoose/.test(name)) return "database";
  return "server";
}

function endpointLabel(req) {
  const hasRoute = req.route && req.route.path !== undefined;
  const path = hasRoute ? `${req.baseUrl || ""}${String(req.route.path)}` : "(unmatched)";
  return `${req.method} ${path}`.slice(0, 120);
}

function addSample(kind, endpoint, ms, statusCode) {
  const bucket = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
  const key = `${kind}|${bucket}|${endpoint}`;
  let entry = buffer.get(key);
  if (!entry) {
    if (buffer.size >= MAX_KEYS) return; // protect memory; drop sample
    entry = { kind, bucket, endpoint, count: 0, totalMs: 0, maxMs: 0, slowCount: 0, ok: 0, c4xx: 0, c5xx: 0 };
    buffer.set(key, entry);
  }
  entry.count += 1;
  entry.totalMs += ms;
  if (ms > entry.maxMs) entry.maxMs = ms;

  if (kind === "api") {
    if (statusCode >= 500) entry.c5xx += 1;
    else if (statusCode >= 400) entry.c4xx += 1;
    else entry.ok += 1;
    if (ms >= SLOW_API_MS) entry.slowCount += 1;
  } else if (ms >= SLOW_DB_MS) {
    entry.slowCount += 1;
  }
}

// ---------------------------------------------------------------- flush
async function flush() {
  if (flushing || mongoose.connection.readyState !== 1) return;
  if (buffer.size === 0 && errorBuffer.length === 0) return;

  flushing = true;
  const entries = Array.from(buffer.values());
  const errors = errorBuffer;
  buffer.clear();
  errorBuffer = [];

  try {
    const ops = entries.map((e) => ({
      updateOne: {
        filter: { key: `${e.kind}|${e.bucket}|${e.endpoint}` },
        update: {
          $inc: {
            count: e.count,
            totalMs: Math.round(e.totalMs * 100) / 100,
            slowCount: e.slowCount,
            ok: e.ok,
            c4xx: e.c4xx,
            c5xx: e.c5xx,
          },
          $max: { maxMs: Math.round(e.maxMs * 100) / 100 },
          $setOnInsert: { kind: e.kind, bucket: new Date(e.bucket), endpoint: e.endpoint },
        },
        upsert: true,
      },
    }));

    errors.forEach((e) =>
      ops.push({
        insertOne: {
          document: {
            kind: "error",
            bucket: e.at,
            endpoint: e.endpoint,
            category: e.category,
            message: e.message,
            statusCode: e.statusCode,
          },
        },
      })
    );

    if (ops.length) await PerfMetric.bulkWrite(ops, { ordered: false });
  } catch (err) {
    console.warn("⚠️ Metrics flush failed (samples dropped):", err.message);
  } finally {
    flushing = false;
  }
}

const timer = setInterval(flush, FLUSH_MS);
timer.unref();

// ---------------------------------------------------------------- Express hooks
function requestMetrics(req, res, next) {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    try {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      addSample("api", endpointLabel(req), ms, res.statusCode);
    } catch (_) {
      /* never let telemetry break a request */
    }
  });
  next();
}

function recordError(req, err, statusCode = 500) {
  try {
    if (errorBuffer.length >= MAX_ERRORS) errorBuffer.shift();
    errorBuffer.push({
      at: new Date(),
      category: categorize(err),
      endpoint: endpointLabel(req),
      message: sanitize(err && err.message),
      statusCode,
    });
  } catch (_) {
    /* ignore */
  }
}

// ---------------------------------------------------------------- Mongoose timing plugin
const starts = new WeakMap();
const QUERY_OPS = [
  "find",
  "findOne",
  "findOneAndUpdate",
  "findOneAndDelete",
  "countDocuments",
  "updateOne",
  "updateMany",
  "deleteOne",
  "deleteMany",
];

function elapsed(target) {
  const s = starts.get(target);
  starts.delete(target);
  return s === undefined ? null : Number(process.hrtime.bigint() - s) / 1e6;
}

mongoose.plugin(function perfTimingPlugin(schema) {
  if (schema.options && schema.options.collection === "perfmetrics") return;

  schema.pre(QUERY_OPS, function () {
    starts.set(this, process.hrtime.bigint());
  });
  schema.post(QUERY_OPS, function () {
    const ms = elapsed(this);
    if (ms !== null) addSample("db", `${this.model.modelName}.${this.op}`, ms);
  });

  schema.pre("aggregate", function () {
    starts.set(this, process.hrtime.bigint());
  });
  schema.post("aggregate", function () {
    const ms = elapsed(this);
    if (ms === null) return;
    const model = typeof this.model === "function" ? this.model() : null;
    addSample("db", `${(model && model.modelName) || "Model"}.aggregate`, ms);
  });

  schema.pre("save", function () {
    starts.set(this, process.hrtime.bigint());
  });
  schema.post("save", function () {
    const ms = elapsed(this);
    if (ms !== null) addSample("db", `${this.constructor.modelName}.save`, ms);
  });
});

function getProcessInfo() {
  const mem = process.memoryUsage();
  return {
    startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    rssMb: Math.round((mem.rss / 1048576) * 10) / 10,
    heapUsedMb: Math.round((mem.heapUsed / 1048576) * 10) / 10,
    nodeVersion: process.version,
  };
}

module.exports = {
  requestMetrics,
  recordError,
  flush,
  getProcessInfo,
  SLOW_API_MS,
  SLOW_DB_MS,
  BUCKET_MS,
};
