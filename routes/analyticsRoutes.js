const express = require("express");
const router = express.Router();

const User = require("../models/User");
const isLoggedIn = require("../middleware/isLoggedIn");
const isAdmin = require("../middleware/isAdmin");
const { recordError } = require("../middleware/metrics");
const analytics = require("../services/analytics");

// ==================== ACCESS CONTROL ====================
// Pages reuse the existing login + admin middleware (redirects).
// JSON / CSV endpoints answer with proper 401 / 403 and re-check the admin role in the
// database, so a demoted or blocked admin loses access immediately, not only at next login.
async function apiGuard(req, res, next) {
  try {
    const sessionUser = req.session && req.session.user;
    if (!sessionUser) return res.status(401).json({ ok: false, error: "Authentication required." });
    if (sessionUser.role !== "admin") return res.status(403).json({ ok: false, error: "Admin access required." });

    const stillAdmin = await User.exists({ _id: sessionUser._id, role: "admin", status: "active", isArchived: false });
    if (!stillAdmin) return res.status(403).json({ ok: false, error: "Admin access required." });
    next();
  } catch (err) {
    recordError(req, err, 500);
    res.status(500).json({ ok: false, error: "Could not verify access." });
  }
}
router.use(["/api", "/export"], apiGuard);

// ==================== PAGE ====================
router.get("/", isLoggedIn, isAdmin, (req, res) => {
  const today = analytics.fmtDay(Date.now());
  const from = analytics.fmtDay(Date.now() - 29 * 24 * 60 * 60 * 1000);
  res.render("admin/analytics", {
    title: "Analytics",
    active: "analytics",
    defaults: {
      from,
      to: today,
      statuses: analytics.ORDER_STATUSES,
      categories: analytics.PRODUCT_CATEGORIES,
    },
  });
});

// ==================== JSON API ====================
function handle(fn) {
  return async (req, res) => {
    try {
      res.json({ ok: true, data: await fn(req.query) });
    } catch (err) {
      if (err instanceof analytics.InputError) return res.status(400).json({ ok: false, error: err.message });
      console.error("❌ Analytics error:", err.message);
      recordError(req, err, 500);
      res.status(500).json({ ok: false, error: "Failed to load analytics data." });
    }
  };
}

router.get("/api/overview", handle(analytics.overview));
router.get("/api/sales", handle(analytics.salesAnalysis));
router.get("/api/orders", handle(analytics.orderAnalysis));
router.get("/api/products", handle((q) => analytics.productAnalysis(q)));
router.get("/api/customers", handle((q) => analytics.customerAnalysis(q)));
router.get("/api/performance", handle(analytics.performanceAnalysis));

// ==================== CSV EXPORT ====================
function cell(v) {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : String(v);
  // Neutralise spreadsheet formula injection for text values
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const toCsv = (rows) => "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
const na = (v) => (v === null || v === undefined ? "N/A" : v);

function header(title, range) {
  return [
    [`KDY's Arts & Crafts - ${title}`],
    ["Period (Asia/Manila)", range.from, "to", range.to],
    ["Generated", new Date().toISOString()],
    [],
  ];
}

const exporters = {
  async sales(q) {
    const d = await analytics.salesAnalysis(q);
    const s = d.summary;
    return [
      ...header("Sales Analysis", d.range),
      ["Metric", "Value"],
      ["Gross sales (PHP)", s.grossSales],
      ["Discounts (PHP)", "N/A (not tracked)"],
      ["Refunds (PHP)", "N/A (not tracked)"],
      ["Net sales (PHP)", s.netSales],
      ["Completed sales (delivered orders)", s.completedSales],
      ["Average order value (PHP)", na(s.averageOrderValue)],
      ["Growth vs previous period (%)", na(s.growthPct)],
      ["Previous period net sales (PHP)", s.previous.netSales],
      ["Cancelled orders value - excluded (PHP)", s.cancelledValue],
      ["Open orders value - not yet recognized (PHP)", s.openOrdersValue],
      [],
      [`Sales by ${d.granularity}`],
      ["Period", "Completed sales", "Revenue (PHP)", "Previous period revenue (PHP)"],
      ...d.trend.map((t) => [t.period, t.orders, t.revenue, na(t.previousRevenue)]),
      [],
      ["Sales by category"],
      ["Category", "Quantity sold", "Revenue (PHP)"],
      ...d.categories.map((c) => [c.category, c.qty, c.revenue]),
    ];
  },

  async orders(q) {
    const d = await analytics.orderAnalysis(q);
    const s = d.summary;
    return [
      ...header("Order Analysis", d.range),
      ["Metric", "Value"],
      ["Total orders", s.total],
      ["Pending", s.pending],
      ["Processing", s.processing],
      ["Ready", s.ready],
      ["Shipped", s.shipped],
      ["Completed (delivered)", s.completed],
      ["Cancelled", s.cancelled],
      ["Completion rate (%)", na(s.completionRate)],
      ["Cancellation rate (%)", na(s.cancellationRate)],
      [],
      [`Order volume by ${d.granularity}${d.statusFilter ? ` (status: ${d.statusFilter})` : ""}`],
      ["Period", "Orders"],
      ...d.volume.map((v) => [v.period, v.orders]),
    ];
  },

  async products(q) {
    const d = await analytics.productAnalysis(q, { all: true });
    const s = d.summary;
    return [
      ...header("Product Analysis", d.range),
      ["Category filter", d.categoryFilter || "All"],
      ["Total products", s.totalProducts],
      ["Total quantity sold", s.totalQuantitySold],
      ["Product revenue (PHP)", s.productRevenue],
      [`Low-stock products (stock <= ${d.lowStockThreshold})`, s.lowStockCount],
      [],
      ["Product", "Category", "Current stock", "Quantity sold", "Revenue (PHP)"],
      ...d.table.rows.map((r) => [r.name, r.category, na(r.stock), r.qty, r.revenue]),
    ];
  },

  async customers(q) {
    const d = await analytics.customerAnalysis(q, { all: true });
    const s = d.summary;
    return [
      ...header("Customer Analysis", d.range),
      ["Metric", "Value"],
      ["Total registered customers", s.totalRegistered],
      ["New customers", s.newCustomers],
      ["Active customers", s.activeCustomers],
      ["Repeat customers", s.repeatCustomers],
      ["Average spending per customer (PHP)", na(s.averageSpendPerCustomer)],
      ["Average orders per customer", na(s.averageOrdersPerCustomer)],
      [],
      ["Customer", "E-mail (masked)", "Orders (non-cancelled)", "Delivered orders", "Total spent (PHP)", "Last order"],
      ...d.table.rows.map((r) => [r.name, na(r.email), r.orders, r.deliveredOrders, r.totalSpent, r.lastOrderAt]),
    ];
  },

  async performance(q) {
    const d = await analytics.performanceAnalysis({ ...q, errLimit: "100", errPage: "1" });
    const a = d.api;
    return [
      ...header("Performance Monitoring", d.range),
      [`API window: last ${d.window}`],
      ["Metric", "Value"],
      ["Total requests", a.totalRequests],
      ["Average response time (ms)", na(a.avgResponseMs)],
      ["Max response time (ms)", na(a.maxResponseMs)],
      ["Server errors (5xx)", a.serverErrors],
      ["Client errors (4xx)", a.clientErrors],
      ["Server error rate (%)", na(a.serverErrorRate)],
      ["Database queries", d.database.queries],
      ["Average DB operation time (ms)", na(d.database.avgMs)],
      ["Average order processing time (ms)", na(d.orderTimes.avgProcessingMs)],
      ["Average order fulfillment time (ms)", na(d.orderTimes.avgFulfillmentMs)],
      [],
      ["Period", "Requests", "Avg response (ms)", "OK", "4xx", "5xx"],
      ...d.series.map((s) => [s.period, s.count, na(s.avgMs), s.ok, s.c4xx, s.c5xx]),
      [],
      ["Recent errors"],
      ["Time", "Category", "Endpoint", "Status", "Message"],
      ...d.errors.rows.map((e) => [e.at, e.category, e.endpoint, e.statusCode, e.message]),
    ];
  },
};

router.get("/export/:module", async (req, res) => {
  const build = Object.prototype.hasOwnProperty.call(exporters, req.params.module) ? exporters[req.params.module] : null;
  if (!build) return res.status(404).json({ ok: false, error: "Unknown export." });

  try {
    const rows = await build(req.query);
    const range = analytics.resolveRange(req.query);
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="kdy-analytics-${req.params.module}-${range.fromStr}_to_${range.toStr}.csv"`,
    });
    res.send(toCsv(rows));
  } catch (err) {
    if (err instanceof analytics.InputError) return res.status(400).json({ ok: false, error: err.message });
    console.error("❌ Analytics export error:", err.message);
    recordError(req, err, 500);
    res.status(500).json({ ok: false, error: "Failed to export report." });
  }
});

module.exports = router;
