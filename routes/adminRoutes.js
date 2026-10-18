const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");

// Models
const Product = require("../models/Product");
const Order = require("../models/Order");
const OrderItem = require("../models/OrderItem");
const Shipping = require("../models/Shipping");
const UploadedFile = require("../models/UploadedFile");
const Notification = require("../models/Notification");
const User = require("../models/User");
const Cart = require("../models/Cart");

// Middleware
const isLoggedIn = require("../middleware/isLoggedIn");
const isAdmin = require("../middleware/isAdmin");

// All admin routes require login + admin role
router.use(isLoggedIn, isAdmin);

// ==================== DASHBOARD ====================
router.get("/dashboard", async (req, res) => {
  try {
    const totalOrders = await Order.countDocuments({ isArchived: false });
    const pendingOrders = await Order.countDocuments({ status: "pending", isArchived: false });
    const deliveredOrdersCount = await Order.countDocuments({ status: "delivered", isArchived: false });
    const totalCustomers = await User.countDocuments({ role: "customer", isArchived: false });
    const availableProducts = await Product.countDocuments({ status: "available", isArchived: false });
    const outOfStockProducts = await Product.countDocuments({ status: "out_of_stock", isArchived: false });

    // 1. Sales & Performance Monitoring
    const revenueResult = await Order.aggregate([
      { $match: { status: "delivered", isArchived: false } },
      { 
        $group: { 
          _id: null, 
          total: { $sum: "$totalAmount" },
          avgOrderValue: { $avg: "$totalAmount" } 
        } 
      },
    ]);
    const totalRevenue = revenueResult.length > 0 ? revenueResult[0].total : 0;
    const avgOrderValue = revenueResult.length > 0 ? revenueResult[0].avgOrderValue : 0;
    const fulfillmentRate = totalOrders > 0 ? ((deliveredOrdersCount / totalOrders) * 100).toFixed(1) : 0;

    // 2. Order Breakdown by Status
    const breakdownResult = await Order.aggregate([
      { $match: { isArchived: false } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    const orderBreakdown = {};
    breakdownResult.forEach((item) => (orderBreakdown[item._id] = item.count));

    // 3. Top 5 Best-Selling Products
    const topProducts = await Order.aggregate([
      { $match: { status: "delivered", isArchived: false } },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.product",
          totalQuantitySold: { $sum: "$items.quantity" },
          totalSales: { $sum: {$multiply: ["$items.quantity", "$items.price"] } }
        }
      },
      { $sort: { totalQuantitySold: -1 } },
      { $limit: 5 }, {$lookup: {
          from: "products",
          localField: "_id",
          foreignField: "_id",
          as: "productDetails"
        }
      },
      { $unwind: { path: "$productDetails", preserveNullAndEmptyArrays: true } }
    ]);

    // 4. Monthly Sales Trend
    const monthlySales = await Order.aggregate([
      { $match: { status: "delivered", isArchived: false } },
      {
        $group: {
          _id: { 
            year: { $year: "$createdAt" }, 
            month: { $month: "$createdAt" } 
          },
          revenue: { $sum: "$totalAmount" },
          orderCount: { $sum: 1 } } }, {$sort: { "_id.year": 1, "_id.month": 1 } },
      { $limit: 6 }
    ]);

    // Recent orders
    const recentOrders = await Order.find({ isArchived: false })
      .populate("userId", "firstName lastName email")
      .sort({ createdAt: -1 })
      .limit(10);

    res.render("admin/dashboard", {
      title: "Dashboard",
      active: "dashboard",
      stats: {
        totalOrders,
        pendingOrders,
        totalRevenue,
        avgOrderValue,
        fulfillmentRate,
        totalCustomers,
        availableProducts,
        outOfStockProducts,
        orderBreakdown,
      },
      topProducts,
      monthlySales,
      recentOrders,
    });
  } catch (err) {
    console.error("❌ Dashboard error:", err.message);
    req.session.error = "Failed to load dashboard.";
    res.redirect("/");
  }
});

// ==================== ORDERS ====================
router.get("/orders", async (req, res) => {
  try {
    const { search, status } = req.query;
    const filter = { isArchived: false };

    if (status) filter.status = status;
    if (search) filter.orderNumber = { $regex: search,$options: "i" };

    const orders = await Order.find(filter)
      .populate("userId", "firstName lastName email")
      .sort({ createdAt: -1 });

    res.render("admin/orders", {
      title: "Manage Orders",
      active: "orders",
      orders,
      search: search || "",
      statusFilter: status || "",
    });
  } catch (err) {
    console.error("❌ Admin orders error:", err.message);
    req.session.error = "Failed to load orders.";
    res.redirect("/admin/dashboard");
  }
});

// GET - Order detail
router.get("/orders/:orderId", async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.orderId, isArchived: false })
      .populate("userId", "firstName lastName email phoneNumber");

    if (!order) {
      req.session.error = "Order not found.";
      return res.redirect("/admin/orders");
    }

    const orderItems = await OrderItem.find({ orderId: order._id, isArchived: false }).populate("productId");
    const shipping = await Shipping.findOne({ orderId: order._id, isArchived: false });
    const uploadedFiles = await UploadedFile.find({ orderId: order._id, isArchived: false });

    res.render("admin/orderDetail", {
      title: `Order #${order.orderNumber}`,
      active: "orders",
      order,
      orderItems,
      shipping,
      uploadedFiles,
    });
  } catch (err) {
    console.error("❌ Admin order detail error:", err.message);
    req.session.error = "Failed to load order.";
    res.redirect("/admin/orders");
  }
});

// POST - Update order status (SYNCHRONIZED WITH SHIPPING)
router.post("/orders/:orderId/status", async (req, res) => {
  try {
    const { status } = req.body;
    
    // 1. Update Order main status
    const order = await Order.findByIdAndUpdate(
      req.params.orderId,
      { status },
      { new: true }
    );

    // 2. Sync status to Shipping collection if shipping record exists
    await Shipping.findOneAndUpdate(
      { orderId: req.params.orderId, isArchived: false },
      { shippingStatus: status },
      { new: true }
    );

    if (order) {
      await Notification.create({
        userId: order.userId,
        title: "Order Status Updated",
        message: `Your order #${order.orderNumber} is now "${status}".`,
        type: "order_update",
      });
    }

    req.session.success = `Order status updated to "${status}".`;
    res.redirect(`/admin/orders/${req.params.orderId}`);
  } catch (err) {
    console.error("❌ Status update error:", err.message);
    req.session.error = "Failed to update order status.";
    res.redirect(`/admin/orders/${req.params.orderId}`);
  }
});

// POST - Add shipping info (SYNCHRONIZED)
router.post("/orders/:orderId/shipping", async (req, res) => {
  try {
    const { estimatedDelivery } = req.body;
    const initialShippingStatus = "preparing";

    await Shipping.create({
      orderId: req.params.orderId,
      estimatedDelivery,
      shippingStatus: initialShippingStatus,
    });

    const order = await Order.findByIdAndUpdate(
      req.params.orderId, 
      { status: initialShippingStatus }, 
      { new: true }
    );

    if (order) {
      await Notification.create({
        userId: order.userId,
        title: "Order Shipped!",
        message: `Your order #${order.orderNumber} has been shipped`,
        type: "order_update",
      });
    }

    req.session.success = "Shipping info added successfully!";
    res.redirect(`/admin/orders/${req.params.orderId}`);
  } catch (err) {
    console.error("❌ Add shipping error:", err.message);
    req.session.error = "Failed to add shipping info.";
    res.redirect(`/admin/orders/${req.params.orderId}`);
  }
});

// POST - Update shipping status (SYNCHRONIZED WITH ORDER)
router.post("/orders/:orderId/shipping/:shippingId/update", async (req, res) => {
  try {
    const { shippingStatus } = req.body;
    const updateData = { shippingStatus };

    if (shippingStatus === "delivered" || shippingStatus === "Delivered") {
      updateData.deliveredAt = new Date();
    }

    // 1. Update Shipping record
    await Shipping.findByIdAndUpdate(req.params.shippingId, updateData);

    // 2. Sync status to Order main model so table list badge updates!
    const order = await Order.findByIdAndUpdate(
      req.params.orderId, 
      { status: shippingStatus }, 
      { new: true }
    );

    if (order && (shippingStatus === "delivered" || shippingStatus === "Delivered")) {
      await Notification.create({
        userId: order.userId,
        title: "Order Delivered!",
        message: `Your order #${order.orderNumber} has been delivered. Thank you for shopping with KDY's Arts & Crafts!`,
        type: "order_update",
      });
    }

    req.session.success = "Shipping status updated!";
    res.redirect(`/admin/orders/${req.params.orderId}`);
  } catch (err) {
    console.error("❌ Shipping update error:", err.message);
    req.session.error = "Failed to update shipping.";
    res.redirect(`/admin/orders/${req.params.orderId}`);
  }
});

// ==================== PRODUCTS ====================
router.get("/products", async (req, res) => {
  try {
    const { search, category } = req.query;
    const filter = { isArchived: false };

    if (category) filter.category = category;
    if (search) filter.name = { $regex: search,$options: "i" };

    const products = await Product.find(filter).sort({ createdAt: -1 });

    res.render("admin/products", {
      title: "Manage Products",
      active: "products",
      products,
      search: search || "",
      categoryFilter: category || "",
    });
  } catch (err) {
    console.error("❌ Admin products error:", err.message);
    req.session.error = "Failed to load products.";
    res.redirect("/admin/dashboard");
  }
});

router.get("/products/add", (req, res) => {
  res.render("admin/productForm", { title: "Add Product", active: "products", product: null });
});

router.post("/products/add", async (req, res) => {
  try {
    const { name, category, description, basePrice, stock, sizes, colors } = req.body;

    let imageUrl = "";
    if (req.files && req.files.length > 0) {
      imageUrl = req.files[0].path;
    }

    await Product.create({
      name,
      category,
      description,
      basePrice: parseFloat(basePrice),
      stock: parseInt(stock) || 0,
      imageUrl,
      sizes: sizes ? sizes.split(",").map((s) => s.trim()).filter(Boolean) : [],
      colors: colors ? colors.split(",").map((c) => c.trim()).filter(Boolean) : [],
      status: parseInt(stock) > 0 ? "available" : "out_of_stock",
    });

    req.session.success = "Product added successfully!";
    res.redirect("/admin/products");
  } catch (err) {
    console.error("❌ Add product error:", err.message);
    req.session.error = "Failed to add product.";
    res.redirect("/admin/products/add");
  }
});

router.get("/products/:productId/edit", async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.productId, isArchived: false });
    if (!product) {
      req.session.error = "Product not found.";
      return res.redirect("/admin/products");
    }
    res.render("admin/productForm", { title: "Edit Product", active: "products", product });
  } catch (err) {
    console.error("❌ Edit product error:", err.message);
    req.session.error = "Failed to load product.";
    res.redirect("/admin/products");
  }
});

router.post("/products/:productId/update", async (req, res) => {
  try {
    const { name, category, description, basePrice, stock, sizes, colors } = req.body;

    const updateData = {
      name,
      category,
      description,
      basePrice: parseFloat(basePrice),
      stock: parseInt(stock) || 0,
      sizes: sizes ? sizes.split(",").map((s) => s.trim()).filter(Boolean) : [],
      colors: colors ? colors.split(",").map((c) => c.trim()).filter(Boolean) : [],
      status: parseInt(stock) > 0 ? "available" : "out_of_stock",
    };

    if (req.files && req.files.length > 0) {
      updateData.imageUrl = req.files[0].path;
    }

    await Product.findByIdAndUpdate(req.params.productId, updateData);

    req.session.success = "Product updated successfully!";
    res.redirect("/admin/products");
  } catch (err) {
    console.error("❌ Update product error:", err.message);
    req.session.error = "Failed to update product.";
    res.redirect(`/admin/products/${req.params.productId}/edit`);
  }
});

router.post("/products/:productId/archive", async (req, res) => {
  try {
    await Product.findByIdAndUpdate(req.params.productId, { isArchived: true });
    req.session.success = "Product archived successfully.";
    res.redirect("/admin/products");
  } catch (err) {
    console.error("❌ Archive product error:", err.message);
    req.session.error = "Failed to archive product.";
    res.redirect("/admin/products");
  }
});

// ==================== CUSTOMERS ====================
router.get("/customers", async (req, res) => {
  try {
    const { search, status } = req.query;
    const filter = { role: "customer", isArchived: false };

    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { firstName: { $regex: search,$options: "i" } },
        { lastName: { $regex: search,$options: "i" } },
        { email: { $regex: search,$options: "i" } },
      ];
    }

    const customers = await User.find(filter).select("-password").sort({ createdAt: -1 });

    res.render("admin/customers", {
      title: "Manage Customers",
      active: "customers",
      customers,
      search: search || "",
      statusFilter: status || "",
    });
  } catch (err) {
    console.error("❌ Admin customers error:", err.message);
    req.session.error = "Failed to load customers.";
    res.redirect("/admin/dashboard");
  }
});

router.post("/customers/:userId/block", async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.params.userId, { status: "blocked" });
    req.session.success = "Customer blocked.";
    res.redirect("/admin/customers");
  } catch (err) {
    console.error("❌ Block error:", err.message);
    req.session.error = "Failed to block customer.";
    res.redirect("/admin/customers");
  }
});

router.post("/customers/:userId/unblock", async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.params.userId, { status: "active" });
    req.session.success = "Customer unblocked.";
    res.redirect("/admin/customers");
  } catch (err) {
    console.error("❌ Unblock error:", err.message);
    req.session.error = "Failed to unblock customer.";
    res.redirect("/admin/customers");
  }
});

// ==================== ADMIN PROFILE ====================
router.get("/profile", async (req, res) => {
  try {
    const profile = await User.findById(req.session.user._id).select("-password");
    res.render("admin/profile", { title: "Admin Profile", active: "profile", profile });
  } catch (err) {
    console.error("❌ Admin profile error:", err.message);
    req.session.error = "Failed to load profile.";
    res.redirect("/admin/dashboard");
  }
});

router.post("/profile/update", async (req, res) => {
  try {
    const { firstName, lastName, phoneNumber } = req.body;
    const updated = await User.findByIdAndUpdate(
      req.session.user._id,
      { firstName, lastName, phoneNumber },
      { new: true }
    ).select("-password");

    req.session.user = updated.toObject();
    req.session.success = "Profile updated!";
    res.redirect("/admin/profile");
  } catch (err) {
    console.error("❌ Admin profile update error:", err.message);
    req.session.error = "Failed to update profile.";
    res.redirect("/admin/profile");
  }
});

router.post("/profile/photo", async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      req.session.error = "No image selected.";
      return res.redirect("/admin/profile");
    }

    const imageUrl = req.files[0].path;
    const updated = await User.findByIdAndUpdate(
      req.session.user._id,
      { profileImage: imageUrl },
      { new: true }
    ).select("-password");

    req.session.user = updated.toObject();
    req.session.success = "Profile photo updated!";
    res.redirect("/admin/profile");
  } catch (err) {
    console.error("❌ Admin photo error:", err.message);
    req.session.error = "Failed to update photo.";
    res.redirect("/admin/profile");
  }
});

router.post("/profile/password", async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmNewPassword } = req.body;

    if (newPassword !== confirmNewPassword) {
      req.session.error = "New passwords do not match.";
      return res.redirect("/admin/profile");
    }

    if (newPassword.length < 6) {
      req.session.error = "Password must be at least 6 characters.";
      return res.redirect("/admin/profile");
    }

    const user = await User.findById(req.session.user._id);
    const isMatch = await bcrypt.compare(currentPassword, user.password);

    if (!isMatch) {
      req.session.error = "Current password is incorrect.";
      return res.redirect("/admin/profile");
    }

    user.password = await bcrypt.hash(newPassword, 12);
    await user.save();

    req.session.success = "Password changed successfully!";
    res.redirect("/admin/profile");
  } catch (err) {
    console.error("❌ Admin password error:", err.message);
    req.session.error = "Failed to change password.";
    res.redirect("/admin/profile");
  }
});

module.exports = router; 