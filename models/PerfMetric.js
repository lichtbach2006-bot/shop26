const mongoose = require("mongoose");

/**
 * Performance telemetry collected by middleware/metrics.js.
 *
 * kind = "api"   -> request timing bucket (10-minute bucket per endpoint)
 * kind = "db"    -> Mongoose operation timing bucket (10-minute bucket per Model.operation)
 * kind = "error" -> one document per unhandled server error (sanitised, no PII/secrets)
 *
 * Documents expire automatically after 30 days (TTL index on `bucket`).
 */
const perfMetricSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["api", "db", "error"], required: true },
    // Unique key for aggregated bucket docs ("kind|bucketMs|endpoint"). Absent on error docs.
    key: { type: String },
    bucket: { type: Date, required: true },
    endpoint: { type: String, default: "" },

    // Aggregated counters (api / db)
    count: { type: Number, default: 0 },
    totalMs: { type: Number, default: 0 },
    maxMs: { type: Number, default: 0 },
    slowCount: { type: Number, default: 0 },
    ok: { type: Number, default: 0 }, // 1xx-3xx responses
    c4xx: { type: Number, default: 0 },
    c5xx: { type: Number, default: 0 },

    // Error docs
    category: { type: String },
    message: { type: String },
    statusCode: { type: Number },
  },
  { collection: "perfmetrics", versionKey: false }
);

perfMetricSchema.index({ bucket: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
perfMetricSchema.index({ kind: 1, bucket: -1 });
perfMetricSchema.index({ key: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("PerfMetric", perfMetricSchema);
