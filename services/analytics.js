"use strict";
/**
 * Analytics service – the single source of truth for every dashboard metric.
 * Cards, charts, tables and CSV exports all call these functions, so a metric
 * can never be defined two different ways.
 *
 * BUSINESS RULES (derived from the existing data model – there is no payment,
 * discount or refund collection):
 *  - Recognized sale        = Order with status "delivered" and isArchived=false
 *                             (same rule the existing admin dashboard uses).
 *  - Sale date              = Order.createdAt (order date), Asia/Manila.
 *  - Revenue amount         = Order.totalAmount. Product/category revenue = OrderItem.subtotal
 *                             of non-cancelled, non-archived items of those orders.
 *  - Cancelled orders       = never counted as sales.
 *  - Open orders            = pending/processing/ready/shipped (reported separately, not revenue).
 *  - Discounts / refunds    = not tracked by the system -> reported as null ("not available").
 */
const Order = require("../models/Order");
const OrderItem = require("../models/OrderItem");
const Product = require("../models/Product");
const User = require("../models/User");
const Shipping = require("../models/Shipping");
const PerfMetric = require("../models/PerfMetric");
const metrics = require("../middleware/metrics");

// ------------------------------------------------------------------ constants
const TZ = "Asia/Manila";
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000; // Philippines has no DST
const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;
const MAX_RANGE_DAYS = 1830;
const MAX_BUCKETS = 400;

const ORDER_STATUSES = Order.schema.path("status").enumValues;
const PRODUCT_CATEGORIES = Product.schema.path("category").enumValues;
const OPEN_STATUSES = ["pending", "processing", "ready", "shipped"];
const GRANULARITIES = ["day", "week", "month", "year"];

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
    this.status = 400;
  }
}

// ------------------------------------------------------------------ small utils
const round2 = (n) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
const round1 = (n) => Math.round(((Number(n) || 0) + Number.EPSILON) * 10) / 10;
const pctChange = (cur, prev) => (prev > 0 ? round1(((cur - prev) / prev) * 100) : null);
const ratio = (a, b) => (b > 0 ? round1((a / b) * 100) : null);

function maskEmail(email) {
  if (!email || !email.includes("@")) return null;
  const [local, domain] = email.split("@");
  return `${local.charAt(0)}***@${domain}`;
}

// ------------------------------------------------------------------ Manila date helpers
const fmtDay = (ms) => new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10);
const manilaParts = (ms) => {
  const d = new Date(ms + TZ_OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay() };
};
const manilaMidnight = (y, m, d) => new Date(Date.UTC(y, m, d) - TZ_OFFSET_MS);

function truncate(ms, unit) {
  const p = manilaParts(ms);
  switch (unit) {
    case "hour":
      return new Date(Math.floor((ms + TZ_OFFSET_MS) / MS_HOUR) * MS_HOUR - TZ_OFFSET_MS);
    case "day":
      return manilaMidnight(p.y, p.m, p.d);
    case "week":
      return manilaMidnight(p.y, p.m, p.d - ((p.dow + 6) % 7)); // Monday
    case "month":
      return manilaMidnight(p.y, p.m, 1);
    case "year":
      return manilaMidnight(p.y, 0, 1);
    default:
      throw new Error(`Unknown unit ${unit}`);
  }
}

function nextBucket(date, unit) {
  const p = manilaParts(date.getTime());
  switch (unit) {
    case "hour":
      return new Date(date.getTime() + MS_HOUR);
    case "day":
      return manilaMidnight(p.y, p.m, p.d + 1);
    case "week":
      return manilaMidnight(p.y, p.m, p.d + 7);
    case "month":
      return manilaMidnight(p.y, p.m + 1, 1);
    case "year":
      return manilaMidnight(p.y + 1, 0, 1);
    default:
      throw new Error(`Unknown unit ${unit}`);
  }
}

function bucketLabel(date, unit) {
  const iso = new Date(date.getTime() + TZ_OFFSET_MS).toISOString();
  switch (unit) {
    case "hour":
      return `${iso.slice(0, 10)} ${iso.slice(11, 13)}:00`;
    case "month":
      return iso.slice(0, 7);
    case "year":
      return iso.slice(0, 4);
    default:
      return iso.slice(0, 10);
  }
}

const MONGO_FORMAT = { hour: "%Y-%m-%d %H:00", day: "%Y-%m-%d", week: "%Y-%m-%d", month: "%Y-%m", year: "%Y" };

function bucketKeys(fromMs, toMs, unit) {
  const keys = [];
  let cur = truncate(fromMs, unit);
  while (cur.getTime() < toMs) {
    keys.push(bucketLabel(cur, unit));
    cur = nextBucket(cur, unit);
    if (keys.length > MAX_BUCKETS + 1) break;
  }
  return keys;
}

// ------------------------------------------------------------------ input validation
function optString(v, name) {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new InputError(`Invalid value for "${name}".`);
  return v.trim();
}

function enumParam(v, name, allowed) {
  const s = optString(v, name);
  if (s === undefined) return undefined;
  if (!allowed.includes(s)) throw new InputError(`Invalid ${name}. Allowed: ${allowed.join(", ")}.`);
  return s;
}

function intParam(v, name, { min, max, def }) {
  const s = optString(v, name);
  if (s === undefined) return def;
  if (!/^-?\d+$/.test(s)) throw new InputError(`"${name}" must be a whole number.`);
  const n = parseInt(s, 10);
  if (n < min || n > max) throw new InputError(`"${name}" must be between ${min} and ${max}.`);
  return n;
}

function parseDay(str, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) throw new InputError(`"${name}" must be a date in YYYY-MM-DD format.`);
  const date = new Date(`${str}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime()) || fmtDay(date.getTime()) !== str) {
    throw new InputError(`"${name}" is not a valid calendar date.`);
  }
  return date;
}

/** Resolve ?from=&to= (inclusive Manila dates). Default = last 30 days. */
function resolveRange(q = {}) {
  const todayStr = fmtDay(Date.now());
  const toStr = optString(q.to, "to") || todayStr;
  const toDate = parseDay(toStr, "to");
  const fromStr = optString(q.from, "from") || fmtDay(toDate.getTime() - 29 * MS_DAY);
  const from = parseDay(fromStr, "from");
  const to = new Date(toDate.getTime() + MS_DAY); // exclusive end

  if (from.getTime() >= to.getTime()) throw new InputError('"from" must be on or before "to".');
  const days = Math.round((to - from) / MS_DAY);
  if (days > MAX_RANGE_DAYS) throw new InputError(`Date range is too large (max ${MAX_RANGE_DAYS} days).`);

  const len = to - from;
  const prev = { from: new Date(from.getTime() - len), to: from };
  return {
    from,
    to,
    fromStr,
    toStr,
    days,
    prev,
    prevFromStr: fmtDay(prev.from.getTime()),
    prevToStr: fmtDay(from.getTime() - MS_DAY),
  };
}

function resolveGranularity(value, range) {
  let unit = enumParam(value, "granularity", ["auto", ...GRANULARITIES]);
  if (!unit || unit === "auto") unit = range.days <= 31 ? "day" : range.days <= 180 ? "week" : "month";
  const keys = bucketKeys(range.from.getTime(), range.to.getTime(), unit);
  if (keys.length > MAX_BUCKETS) {
    throw new InputError("Too many periods for this range. Choose a coarser granularity or a shorter date range.");
  }
  return { unit, keys };
}

const rangeMeta = (range) => ({
  from: range.fromStr,
  to: range.toStr,
  days: range.days,
  previous: { from: range.prevFromStr, to: range.prevToStr },
  timezone: TZ,
});

// ------------------------------------------------------------------ shared query helpers
const orderBase = (from, to) => ({ isArchived: false, createdAt: { $gte: from, $lt: to } });

async function sumOrders(from, to, statusMatch) {
  const rows = await Order.aggregate([
    { $match: { ...orderBase(from, to), ...statusMatch } },
    { $group: { _id: null, amount: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
  ]);
  return rows.length ? { amount: round2(rows[0].amount), count: rows[0].count } : { amount: 0, count: 0 };
}

/** Group a collection by period and fill empty periods with zeros. */
async function periodSeries(Model, match, unit, accumulators, keys, dateField = "createdAt") {
  // day / month / year / hour buckets only need $dateToString (works on every MongoDB version);
  // only ISO weeks need $dateTrunc (MongoDB 5.0+) to snap to Monday.
  let dateExpr = `$${dateField}`;
  if (unit === "week") dateExpr = { $dateTrunc: { date: dateExpr, unit: "week", timezone: TZ, startOfWeek: "monday" } };

  const rows = await Model.aggregate([
    { $match: match },
    { $group: { _id: { $dateToString: { date: dateExpr, format: MONGO_FORMAT[unit], timezone: TZ } }, ...accumulators } },
  ]);
  const map = new Map(rows.map((r) => [r._id, r]));
  const zero = Object.fromEntries(Object.keys(accumulators).map((k) => [k, 0]));
  return keys.map((period) => {
    const r = map.get(period);
    const out = { period };
    for (const k of Object.keys(zero)) out[k] = r ? r[k] : 0;
    return out;
  });
}

/** Pipeline stages: delivered orders in range -> one row per sold order item. */
function soldItemStages(from, to) {
  return [
    { $match: { ...orderBase(from, to), status: "delivered" } },
    { $project: { _id: 1 } },
    { $lookup: { from: OrderItem.collection.name, localField: "_id", foreignField: "orderId", as: "items" } },
    { $unwind: "$items" },
    // Archived items and cancelled lines never count as sold (uses the OrderItem.orderId index)
    { $match: { "items.isArchived": false, "items.status": { $ne: "cancelled" } } },
  ];
}

/** Calendar period totals (today / this week / this month / this year vs the previous full period). */
async function periodTotals() {
  const now = Date.now();
  const p = manilaParts(now);
  const todayStart = manilaMidnight(p.y, p.m, p.d);
  const weekStart = truncate(now, "week");
  const monthStart = manilaMidnight(p.y, p.m, 1);
  const yearStart = manilaMidnight(p.y, 0, 1);

  const defs = [
    { key: "day", label: ["Today", "Yesterday"], cur: todayStart, prev: manilaMidnight(p.y, p.m, p.d - 1) },
    { key: "week", label: ["This week", "Last week"], cur: weekStart, prev: new Date(weekStart.getTime() - 7 * MS_DAY) },
    { key: "month", label: ["This month", "Last month"], cur: monthStart, prev: manilaMidnight(p.y, p.m - 1, 1) },
    { key: "year", label: ["This year", "Last year"], cur: yearStart, prev: manilaMidnight(p.y - 1, 0, 1) },
  ];

  const inRange = (a, b) => ({ $and: [{ $gte: ["$createdAt", a] }, { $lt: ["$createdAt", b] }] });
  const group = { _id: null };
  defs.forEach((d) => {
    const curRange = inRange(d.cur, new Date(now + MS_DAY * 366));
    const prevRange = inRange(d.prev, d.cur);
    group[`${d.key}CurRev`] = { $sum: { $cond: [{ $and: [{ $eq: ["$status", "delivered"] }, curRange] }, "$totalAmount", 0] } };
    group[`${d.key}PrevRev`] = { $sum: { $cond: [{ $and: [{ $eq: ["$status", "delivered"] }, prevRange] }, "$totalAmount", 0] } };
    group[`${d.key}CurOrd`] = { $sum: { $cond: [curRange, 1, 0] } };
    group[`${d.key}PrevOrd`] = { $sum: { $cond: [prevRange, 1, 0] } };
  });

  const earliest = new Date(Math.min(...defs.map((d) => d.prev.getTime())));
  const rows = await Order.aggregate([{ $match: { isArchived: false, createdAt: { $gte: earliest } } }, { $group: group }]);
  const r = rows[0] || {};

  return defs.map((d) => ({
    key: d.key,
    currentLabel: d.label[0],
    previousLabel: d.label[1],
    revenue: { current: round2(r[`${d.key}CurRev`]), previous: round2(r[`${d.key}PrevRev`]) },
    orders: { current: r[`${d.key}CurOrd`] || 0, previous: r[`${d.key}PrevOrd`] || 0 },
  }));
}

// ====================================================================== SALES
async function salesAnalysis(q = {}) {
  const range = resolveRange(q);
  const { unit, keys } = resolveGranularity(q.granularity, range);
  const prevKeys = bucketKeys(range.prev.from.getTime(), range.prev.to.getTime(), unit);

  const [cur, prev, cancelled, open, trend, prevTrend, categoryRows, periods] = await Promise.all([
    sumOrders(range.from, range.to, { status: "delivered" }),
    sumOrders(range.prev.from, range.prev.to, { status: "delivered" }),
    sumOrders(range.from, range.to, { status: "cancelled" }),
    sumOrders(range.from, range.to, { status: { $in: OPEN_STATUSES } }),
    periodSeries(
      Order,
      { ...orderBase(range.from, range.to), status: "delivered" },
      unit,
      { revenue: { $sum: "$totalAmount" }, orders: { $sum: 1 } },
      keys
    ),
    periodSeries(
      Order,
      { ...orderBase(range.prev.from, range.prev.to), status: "delivered" },
      unit,
      { revenue: { $sum: "$totalAmount" } },
      prevKeys
    ),
    Order.aggregate([
      ...soldItemStages(range.from, range.to),
      {
        $lookup: { from: Product.collection.name, localField: "items.productId", foreignField: "_id", as: "p" },
      },
      {
        $group: {
          _id: { $ifNull: [{ $arrayElemAt: ["$p.category", 0] }, "unknown"] },
          revenue: { $sum: "$items.subtotal" },
          qty: { $sum: "$items.quantity" },
        },
      },
      { $sort: { revenue: -1 } },
    ]),
    periodTotals(),
  ]);

  const aov = cur.count > 0 ? round2(cur.amount / cur.count) : null;
  const prevAov = prev.count > 0 ? round2(prev.amount / prev.count) : null;

  return {
    range: rangeMeta(range),
    granularity: unit,
    hasData: cur.count > 0,
    summary: {
      grossSales: cur.amount,
      discounts: null, // not tracked
      refunds: null, // not tracked
      netSales: cur.amount,
      completedSales: cur.count,
      averageOrderValue: aov,
      growthPct: pctChange(cur.amount, prev.amount),
      previous: { netSales: prev.amount, completedSales: prev.count, averageOrderValue: prevAov },
      cancelledValue: cancelled.amount,
      cancelledCount: cancelled.count,
      openOrdersValue: open.amount,
      openOrdersCount: open.count,
    },
    trend: trend.map((t, i) => ({
      period: t.period,
      revenue: round2(t.revenue),
      orders: t.orders,
      previousRevenue: i < prevTrend.length ? round2(prevTrend[i].revenue) : null,
    })),
    periodTotals: periods,
    categories: categoryRows.map((c) => ({ category: c._id, revenue: round2(c.revenue), qty: c.qty })),
    definitions: [
      'Recognized sales = orders with status "delivered" (cancelled, pending, processing, ready and shipped orders are excluded).',
      "Sale date = the order date (Order.createdAt) in Asia/Manila time.",
      "Gross sales = sum of Order.totalAmount of recognized sales. Discounts and refunds are not tracked by the system, so Net sales = Gross sales.",
      "Average order value = recognized revenue ÷ number of recognized sales.",
      `Growth % compares with the previous period of equal length (${range.prevFromStr} to ${range.prevToStr}); shown as N/A when the previous period had no sales.`,
      "Calendar comparison bars: current period to date vs the previous full period.",
      "Category revenue = sum of non-cancelled order item subtotals of recognized sales.",
    ],
  };
}

// ====================================================================== ORDERS
async function orderAnalysis(q = {}) {
  const range = resolveRange(q);
  const status = enumParam(q.status, "status", ORDER_STATUSES);
  const { unit, keys } = resolveGranularity(q.granularity, range);
  const base = orderBase(range.from, range.to);

  const [statusRows, series, periods] = await Promise.all([
    Order.aggregate([{ $match: base }, { $group: { _id: "$status", count: { $sum: 1 }, amount: { $sum: "$totalAmount" } } }]),
    periodSeries(Order, status ? { ...base, status } : base, unit, { orders: { $sum: 1 } }, keys),
    periodTotals(),
  ]);

  const byStatus = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0]));
  const amountByStatus = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0]));
  statusRows.forEach((r) => {
    if (r._id in byStatus) {
      byStatus[r._id] = r.count;
      amountByStatus[r._id] = round2(r.amount);
    }
  });
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);

  const seriesTotal = series.reduce((a, s) => a + s.orders, 0);
  let peak = null;
  let low = null;
  if (seriesTotal > 0) {
    peak = series.reduce((best, s) => (s.orders > best.orders ? s : best), series[0]);
    low = series.reduce((best, s) => (s.orders < best.orders ? s : best), series[0]);
  }

  return {
    range: rangeMeta(range),
    granularity: unit,
    statusFilter: status || null,
    hasData: total > 0,
    summary: {
      total,
      pending: byStatus.pending,
      processing: byStatus.processing,
      ready: byStatus.ready,
      shipped: byStatus.shipped,
      completed: byStatus.delivered,
      cancelled: byStatus.cancelled,
      completionRate: ratio(byStatus.delivered, total),
      cancellationRate: ratio(byStatus.cancelled, total),
    },
    byStatus,
    amountByStatus,
    mostCommonStatuses: ORDER_STATUSES.map((s) => ({ status: s, count: byStatus[s] }))
      .filter((s) => s.count > 0)
      .sort((a, b) => b.count - a.count),
    volume: series,
    volumeTotal: seriesTotal,
    peakPeriod: peak,
    lowPeriod: low,
    periodTotals: periods,
    definitions: [
      "Orders are grouped by their actual status: pending, processing, ready (ready for pickup), shipped, delivered (completed) and cancelled.",
      "Order date = Order.createdAt in Asia/Manila time. Archived orders are excluded.",
      "Completion rate = delivered ÷ all orders in the range. Cancellation rate = cancelled ÷ all orders in the range.",
      "The status filter applies to the volume line chart only; the status cards, rates and doughnut always use all statuses.",
      "Peak / lowest periods are measured over every period in the range, including periods with zero orders.",
    ],
  };
}

// ====================================================================== PRODUCTS
async function productAnalysis(q = {}, opts = {}) {
  const range = resolveRange(q);
  const category = enumParam(q.category, "category", PRODUCT_CATEGORIES);
  const lowStockThreshold = intParam(q.lowStock, "lowStock", { min: 0, max: 100000, def: 10 });
  const page = intParam(q.page, "page", { min: 1, max: 100000, def: 1 });
  const limit = intParam(q.limit, "limit", { min: 1, max: 100, def: 10 });
  const sort = enumParam(q.sort, "sort", ["revenue", "qty", "name", "stock"]) || "revenue";

  const [soldRows, activeProducts] = await Promise.all([
    Order.aggregate([
      ...soldItemStages(range.from, range.to),
      { $group: { _id: "$items.productId", qty: { $sum: "$items.quantity" }, revenue: { $sum: "$items.subtotal" } } },
    ]),
    Product.find({ isArchived: false, ...(category ? { category } : {}) })
      .select("name category stock status")
      .lean(),
  ]);

  const soldMap = new Map(soldRows.map((r) => [String(r._id), r]));
  const activeIds = new Set(activeProducts.map((p) => String(p._id)));
  const otherIds = soldRows.map((r) => r._id).filter((id) => id && !activeIds.has(String(id)));
  const others = otherIds.length ? await Product.find({ _id: { $in: otherIds } }).select("name category").lean() : [];
  const otherMap = new Map(others.map((p) => [String(p._id), p]));

  const rows = activeProducts.map((p) => {
    const s = soldMap.get(String(p._id));
    return {
      id: String(p._id),
      name: p.name,
      category: p.category,
      stock: p.stock,
      status: p.status,
      archived: false,
      qty: s ? s.qty : 0,
      revenue: s ? round2(s.revenue) : 0,
    };
  });
  // Sold products that were archived (or deleted) still count towards totals.
  soldRows.forEach((r) => {
    const id = String(r._id);
    if (activeIds.has(id)) return;
    const p = otherMap.get(id);
    if (category && (!p || p.category !== category)) return;
    rows.push({
      id,
      name: p ? `${p.name} (archived)` : "(deleted product)",
      category: p ? p.category : "unknown",
      stock: null,
      status: null,
      archived: true,
      qty: r.qty,
      revenue: round2(r.revenue),
    });
  });

  const totalQty = rows.reduce((a, r) => a + r.qty, 0);
  const totalRevenue = round2(rows.reduce((a, r) => a + r.revenue, 0));

  const byQty = (a, b) => b.qty - a.qty || b.revenue - a.revenue || a.name.localeCompare(b.name);
  const bestSelling = rows.filter((r) => r.qty > 0).sort(byQty).slice(0, 10);
  const topRevenue = rows.filter((r) => r.revenue > 0).sort((a, b) => b.revenue - a.revenue || b.qty - a.qty).slice(0, 10);
  const lowestSelling = rows
    .filter((r) => !r.archived)
    .sort((a, b) => a.qty - b.qty || a.revenue - b.revenue || a.name.localeCompare(b.name))
    .slice(0, 10);

  const catMap = new Map();
  rows.forEach((r) => {
    const c = catMap.get(r.category) || { category: r.category, products: 0, qty: 0, revenue: 0 };
    if (!r.archived) c.products += 1;
    c.qty += r.qty;
    c.revenue = round2(c.revenue + r.revenue);
    catMap.set(r.category, c);
  });
  const categories = Array.from(catMap.values()).sort((a, b) => b.revenue - a.revenue);

  const active = rows.filter((r) => !r.archived);
  const lowStock = active
    .filter((r) => r.stock <= lowStockThreshold)
    .sort((a, b) => a.stock - b.stock || a.name.localeCompare(b.name))
    .map((r) => ({ id: r.id, name: r.name, category: r.category, stock: r.stock, status: r.status }));
  const inventory = [...active]
    .sort((a, b) => a.stock - b.stock || a.name.localeCompare(b.name))
    .slice(0, 10)
    .map((r) => ({ name: r.name, stock: r.stock }));

  const sorters = {
    revenue: (a, b) => b.revenue - a.revenue || b.qty - a.qty || a.name.localeCompare(b.name),
    qty: byQty,
    name: (a, b) => a.name.localeCompare(b.name),
    stock: (a, b) => (a.stock ?? Infinity) - (b.stock ?? Infinity) || a.name.localeCompare(b.name),
  };
  const sorted = [...rows].sort(sorters[sort]);
  const pages = Math.max(1, Math.ceil(sorted.length / limit));
  const tableRows = opts.all ? sorted : sorted.slice((page - 1) * limit, page * limit);

  return {
    range: rangeMeta(range),
    categoryFilter: category || null,
    lowStockThreshold,
    hasData: totalQty > 0,
    summary: {
      totalProducts: activeProducts.length,
      totalQuantitySold: totalQty,
      productRevenue: totalRevenue,
      lowStockCount: lowStock.length,
      outOfStockCount: active.filter((r) => r.stock === 0).length,
      bestSeller: bestSelling[0] ? { name: bestSelling[0].name, qty: bestSelling[0].qty } : null,
    },
    bestSelling,
    topRevenue,
    lowestSelling,
    categories,
    lowStock,
    inventory,
    table: { rows: tableRows, page: opts.all ? 1 : Math.min(page, pages), limit, total: sorted.length, pages: opts.all ? 1 : pages, sort },
    definitions: [
      "Quantity sold and product revenue come from order items (OrderItem.quantity and OrderItem.subtotal) belonging to delivered orders placed in the date range. Cancelled orders and cancelled items are never counted.",
      "Lowest-selling lists active (non-archived) products only, including products with zero sales.",
      `Low stock = active products with stock ≤ ${lowStockThreshold}. Stock levels are the current stock, not stock during the date range.`,
      "Archived or deleted products that were sold in the range still count toward totals and are labelled.",
      "Total products = active (non-archived) products, within the selected category if one is chosen.",
    ],
  };
}

// ====================================================================== CUSTOMERS
async function customerAnalysis(q = {}, opts = {}) {
  const range = resolveRange(q);
  const { unit, keys } = resolveGranularity(q.granularity, range);
  const page = intParam(q.page, "page", { min: 1, max: 100000, def: 1 });
  const limit = intParam(q.limit, "limit", { min: 1, max: 100, def: 10 });
  const sort = enumParam(q.sort, "sort", ["spend", "orders"]) || "spend";

  const perCustomer = [
    { $match: orderBase(range.from, range.to) },
    {
      $group: {
        _id: "$userId",
        placed: { $sum: { $cond: [{ $ne: ["$status", "cancelled"] }, 1, 0] } },
        delivered: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] } },
        spend: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, "$totalAmount", 0] } },
        lastOrderAt: { $max: "$createdAt" },
      },
    },
    { $match: { placed: { $gt: 0 } } },
  ];
  const sortStage = sort === "orders" ? { $sort: { placed: -1, spend: -1, _id: 1 } } : { $sort: { spend: -1, placed: -1, _id: 1 } };
  const regMatch = { role: "customer", isArchived: false, createdAt: { $gte: range.from, $lt: range.to } };

  const tableStages = opts.all ? [sortStage] : [sortStage, { $skip: (page - 1) * limit }, { $limit: limit }];

  const [totalRegistered, newCustomers, registrations, summaryRows, tableRows, tableCount, topSpenders, topFrequent] =
    await Promise.all([
      User.countDocuments({ role: "customer", isArchived: false }),
      User.countDocuments(regMatch),
      periodSeries(User, regMatch, unit, { customers: { $sum: 1 } }, keys),
      Order.aggregate([
        ...perCustomer,
        {
          $group: {
            _id: null,
            active: { $sum: 1 },
            orders: { $sum: "$placed" },
            delivered: { $sum: "$delivered" },
            spend: { $sum: "$spend" },
            paying: { $sum: { $cond: [{ $gt: ["$delivered", 0] }, 1, 0] } },
            repeat: { $sum: { $cond: [{ $gt: ["$delivered", 1] }, 1, 0] } },
            oneTime: { $sum: { $cond: [{ $eq: ["$delivered", 1] }, 1, 0] } },
          },
        },
      ]),
      Order.aggregate([...perCustomer, ...tableStages]),
      Order.aggregate([...perCustomer, { $count: "n" }]),
      Order.aggregate([...perCustomer, { $match: { spend: { $gt: 0 } } }, { $sort: { spend: -1, _id: 1 } }, { $limit: 10 }]),
      Order.aggregate([...perCustomer, { $sort: { placed: -1, spend: -1, _id: 1 } }, { $limit: 5 }]),
    ]);

  const ids = [...new Set([...tableRows, ...topSpenders, ...topFrequent].map((r) => String(r._id)))];
  const users = ids.length ? await User.find({ _id: { $in: ids } }).select("firstName lastName email status").lean() : [];
  const userMap = new Map(users.map((u) => [String(u._id), u]));

  const shape = (r) => {
    const u = userMap.get(String(r._id));
    return {
      id: String(r._id),
      name: u ? `${u.firstName} ${u.lastName}`.trim() : "(deleted customer)",
      email: u ? maskEmail(u.email) : null, // PII is masked in analytics; full details are on the Customers page
      orders: r.placed,
      deliveredOrders: r.delivered,
      totalSpent: round2(r.spend),
      lastOrderAt: r.lastOrderAt,
    };
  };

  const s = summaryRows[0] || { active: 0, orders: 0, delivered: 0, spend: 0, paying: 0, repeat: 0, oneTime: 0 };
  const totalActive = tableCount[0] ? tableCount[0].n : 0;
  const pages = Math.max(1, Math.ceil(totalActive / limit));

  return {
    range: rangeMeta(range),
    granularity: unit,
    hasData: s.active > 0 || newCustomers > 0,
    summary: {
      totalRegistered,
      newCustomers,
      activeCustomers: s.active,
      repeatCustomers: s.repeat,
      oneTimeCustomers: s.oneTime,
      payingCustomers: s.paying,
      averageSpendPerCustomer: s.paying > 0 ? round2(s.spend / s.paying) : null,
      averageOrdersPerCustomer: s.active > 0 ? round2(s.orders / s.active) : null,
      totalSpend: round2(s.spend),
    },
    registrations,
    topSpenders: topSpenders.map(shape),
    topFrequent: topFrequent.map(shape),
    table: {
      rows: tableRows.map(shape),
      page: opts.all ? 1 : Math.min(page, pages),
      limit,
      total: totalActive,
      pages: opts.all ? 1 : pages,
      sort,
    },
    definitions: [
      "Total registered customers = all non-archived accounts with the customer role (all-time, including blocked).",
      "New customers = customer accounts created within the date range.",
      "Active customers = customers who placed at least one non-cancelled order within the date range.",
      'Qualifying order (for spending and repeat) = a delivered order. Repeat customers have more than one delivered order in the range; one-time customers have exactly one.',
      "Average spending = delivered revenue ÷ customers with at least one delivered order. Average orders = non-cancelled orders ÷ active customers.",
      "Customer e-mail addresses are masked here; full details are only on the admin Customers page.",
    ],
  };
}

// ====================================================================== PERFORMANCE
const WINDOWS = { "24h": 24, "7d": 168, "30d": 720 };

async function performanceAnalysis(q = {}) {
  const win = enumParam(q.window, "window", Object.keys(WINDOWS)) || "24h";
  const errPage = intParam(q.errPage, "errPage", { min: 1, max: 10000, def: 1 });
  const errLimit = intParam(q.errLimit, "errLimit", { min: 1, max: 100, def: 10 });
  const range = resolveRange(q);

  await metrics.flush(); // include samples still buffered in memory

  const now = Date.now();
  const since = new Date(now - WINDOWS[win] * MS_HOUR);
  const unit = win === "24h" ? "hour" : "day";
  const keys = bucketKeys(since.getTime(), now + 1, unit);

  const kindSummary = (kind) =>
    PerfMetric.aggregate([
      { $match: { kind, bucket: { $gte: since } } },
      {
        $group: {
          _id: null,
          count: { $sum: "$count" },
          totalMs: { $sum: "$totalMs" },
          maxMs: { $max: "$maxMs" },
          slow: { $sum: "$slowCount" },
          ok: { $sum: "$ok" },
          c4xx: { $sum: "$c4xx" },
          c5xx: { $sum: "$c5xx" },
        },
      },
    ]);
  const slowest = (kind) =>
    PerfMetric.aggregate([
      { $match: { kind, bucket: { $gte: since } } },
      {
        $group: {
          _id: "$endpoint",
          count: { $sum: "$count" },
          totalMs: { $sum: "$totalMs" },
          maxMs: { $max: "$maxMs" },
          errors: { $sum: "$c5xx" },
        },
      },
      { $addFields: { avgMs: { $cond: [{ $gt: ["$count", 0] }, { $divide: ["$totalMs", "$count"] }, 0] } } },
      { $sort: { avgMs: -1 } },
      { $limit: 5 },
    ]);

  const [apiRows, dbRows, apiSeries, slowApi, slowDb, errorRows, errorTotal, errorCats, firstSample, shipTimes] =
    await Promise.all([
      kindSummary("api"),
      kindSummary("db"),
      periodSeries(
        PerfMetric,
        { kind: "api", bucket: { $gte: since } },
        unit,
        {
          count: { $sum: "$count" },
          totalMs: { $sum: "$totalMs" },
          ok: { $sum: "$ok" },
          c4xx: { $sum: "$c4xx" },
          c5xx: { $sum: "$c5xx" },
        },
        keys,
        "bucket"
      ),
      slowest("api"),
      slowest("db"),
      PerfMetric.find({ kind: "error", bucket: { $gte: since } })
        .sort({ bucket: -1 })
        .skip((errPage - 1) * errLimit)
        .limit(errLimit)
        .lean(),
      PerfMetric.countDocuments({ kind: "error", bucket: { $gte: since } }),
      PerfMetric.aggregate([
        { $match: { kind: "error", bucket: { $gte: since } } },
        { $group: { _id: "$category", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      PerfMetric.findOne({ kind: "api" }).sort({ bucket: 1 }).select("bucket").lean(),
      // One row per order (an order may have several Shipping docs) -> avoid double counting.
      Shipping.aggregate([
        { $match: { isArchived: false } },
        { $group: { _id: "$orderId", shippedAt: { $min: "$createdAt" }, deliveredAt: { $max: "$deliveredAt" } } },
        { $lookup: { from: Order.collection.name, localField: "_id", foreignField: "_id", as: "o" } },
        { $unwind: "$o" },
        { $match: { "o.isArchived": false, "o.status": { $ne: "cancelled" }, "o.createdAt": { $gte: range.from, $lt: range.to } } },
        {
          $project: {
            processingMs: { $subtract: ["$shippedAt", "$o.createdAt"] },
            fulfillmentMs: { $cond: [{ $ne: ["$deliveredAt", null] }, { $subtract: ["$deliveredAt", "$o.createdAt"] }, null] },
          },
        },
        {
          $group: {
            _id: null,
            processingAvg: { $avg: "$processingMs" },
            processingN: { $sum: 1 },
            fulfillmentAvg: { $avg: "$fulfillmentMs" },
            fulfillmentN: { $sum: { $cond: [{ $ne: ["$fulfillmentMs", null] }, 1, 0] } },
          },
        },
      ]),
    ]);

  const a = apiRows[0] || { count: 0, totalMs: 0, maxMs: 0, slow: 0, ok: 0, c4xx: 0, c5xx: 0 };
  const d = dbRows[0] || { count: 0, totalMs: 0, maxMs: 0, slow: 0 };
  const t = shipTimes[0] || {};

  return {
    window: win,
    range: rangeMeta(range),
    hasData: a.count > 0,
    collectingSince: firstSample ? firstSample.bucket : null,
    api: {
      totalRequests: a.count,
      successful: a.ok,
      clientErrors: a.c4xx,
      serverErrors: a.c5xx,
      avgResponseMs: a.count ? round2(a.totalMs / a.count) : null,
      maxResponseMs: a.count ? round2(a.maxMs) : null,
      slowRequests: a.slow,
      serverErrorRate: ratio(a.c5xx, a.count),
      clientErrorRate: ratio(a.c4xx, a.count),
      failureRate: ratio(a.c4xx + a.c5xx, a.count),
    },
    series: apiSeries.map((s) => ({
      period: s.period,
      avgMs: s.count ? round2(s.totalMs / s.count) : null,
      count: s.count,
      ok: s.ok,
      c4xx: s.c4xx,
      c5xx: s.c5xx,
    })),
    slowestEndpoints: slowApi.map((r) => ({
      endpoint: r._id,
      count: r.count,
      avgMs: round2(r.avgMs),
      maxMs: round2(r.maxMs),
      serverErrors: r.errors,
    })),
    database: {
      queries: d.count,
      avgMs: d.count ? round2(d.totalMs / d.count) : null,
      maxMs: d.count ? round2(d.maxMs) : null,
      slowQueries: d.slow,
      slowThresholdMs: metrics.SLOW_DB_MS,
      slowestOperations: slowDb.map((r) => ({ operation: r._id, count: r.count, avgMs: round2(r.avgMs), maxMs: round2(r.maxMs) })),
    },
    errors: {
      total: errorTotal,
      byCategory: errorCats.map((c) => ({ category: c._id || "server", count: c.count })),
      page: errPage,
      limit: errLimit,
      pages: Math.max(1, Math.ceil(errorTotal / errLimit)),
      rows: errorRows.map((e) => ({
        at: e.bucket,
        category: e.category,
        endpoint: e.endpoint,
        statusCode: e.statusCode,
        message: e.message,
      })),
    },
    orderTimes: {
      avgProcessingMs: t.processingAvg != null ? Math.round(t.processingAvg) : null,
      processingSample: t.processingN || 0,
      avgFulfillmentMs: t.fulfillmentAvg != null ? Math.round(t.fulfillmentAvg) : null,
      fulfillmentSample: t.fulfillmentN || 0,
    },
    application: metrics.getProcessInfo(),
    infrastructure: {
      cpuUsage: null,
      ramUsage: null,
      serverUptime: null,
      note:
        "Host-level CPU, RAM and server uptime are not available from the application. Additional monitoring integration (e.g. your hosting provider's metrics or an APM/agent) is required. Only Node.js process figures are shown.",
    },
    definitions: [
      "API metrics are measured by server middleware on every request (time from request start to response finish) and stored in 10-minute buckets. Redirects (3xx) count as successful.",
      "Server error rate = 5xx responses ÷ all requests. Client errors are 4xx responses (e.g. 404). Errors that a route catches itself and answers with a redirect are not visible to this monitor.",
      `Database timings measure each Mongoose query, aggregation and save; operations slower than ${metrics.SLOW_DB_MS} ms are counted as slow.`,
      "Recent errors list unhandled server errors. Messages are sanitised (e-mails, ids, tokens removed) and truncated; no request data is stored.",
      "Order processing time = order placed → shipping record created. Fulfillment time = order placed → delivered (requires a shipping record with a delivery time). Both use the dashboard date range and ignore cancelled orders; orders without shipping data are not measurable and are excluded.",
      "Metrics are kept for 30 days and only exist from the moment this monitoring was deployed.",
    ],
  };
}

// ====================================================================== OVERVIEW
async function overview(q = {}) {
  const [sales, orders, products, customers, perf] = await Promise.all([
    salesAnalysis(q),
    orderAnalysis({ ...q, status: undefined }),
    productAnalysis({ ...q, page: undefined, limit: undefined, category: undefined }),
    customerAnalysis({ ...q, page: undefined, limit: undefined }),
    performanceAnalysis({ ...q, window: "24h", errPage: undefined, errLimit: undefined }),
  ]);

  return {
    range: sales.range,
    granularity: sales.granularity,
    sales: {
      netSales: sales.summary.netSales,
      growthPct: sales.summary.growthPct,
      completedSales: sales.summary.completedSales,
      averageOrderValue: sales.summary.averageOrderValue,
    },
    orders: {
      total: orders.summary.total,
      pending: orders.summary.pending,
      completionRate: orders.summary.completionRate,
      cancellationRate: orders.summary.cancellationRate,
    },
    products: {
      totalProducts: products.summary.totalProducts,
      lowStockCount: products.summary.lowStockCount,
      outOfStockCount: products.summary.outOfStockCount,
      bestSeller: products.summary.bestSeller,
    },
    customers: {
      totalRegistered: customers.summary.totalRegistered,
      newCustomers: customers.summary.newCustomers,
      activeCustomers: customers.summary.activeCustomers,
      repeatCustomers: customers.summary.repeatCustomers,
    },
    performance: {
      hasData: perf.hasData,
      avgResponseMs: perf.api.avgResponseMs,
      serverErrorRate: perf.api.serverErrorRate,
      avgProcessingMs: perf.orderTimes.avgProcessingMs,
    },
    salesTrend: sales.trend,
    byStatus: orders.byStatus,
    definitions: [
      "Overview cards use the same definitions as the detailed tabs (see each tab's “How is this calculated?”).",
      "System performance uses the last 24 hours of server metrics; order processing time uses the selected date range.",
    ],
  };
}

module.exports = {
  InputError,
  ORDER_STATUSES,
  PRODUCT_CATEGORIES,
  TZ,
  resolveRange,
  fmtDay,
  overview,
  salesAnalysis,
  orderAnalysis,
  productAnalysis,
  customerAnalysis,
  performanceAnalysis,
};
