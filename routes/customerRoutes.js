const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");

// Models
const Product = require("../models/Product");
const Cart = require("../models/Cart");
const Order = require("../models/Order");
const OrderItem = require("../models/OrderItem");
const Shipping = require("../models/Shipping");
const UploadedFile = require("../models/UploadedFile");
const Notification = require("../models/Notification");
const User = require("../models/User");

// Middleware
const isLoggedIn = require("../middleware/isLoggedIn");
const isCustomer = require("../middleware/isCustomer");

// All customer routes require login + customer role
router.use(isLoggedIn, isCustomer);

// ==================== SHOP ====================
router.get("/shop", async (req, res) => {
  try {
    const { search, category } = req.query;
    const filter = { isArchived: false, status: "available" };

    if (category) filter.category = category;
    if (search) filter.name = { $regex: search, $options: "i" };

    const products = await Product.find(filter).sort({ createdAt: -1 });

    res.render("customer/shop", {
      title: "Shop",
      active: "shop",
      products,
      search: search || "",
      category: category || "",
    });
  } catch (err) {
    console.error("❌ Shop error:", err.message);
    req.session.error = "Failed to load products.";
    res.redirect("/");
  }
});

// GET - Product detail
router.get("/shop/:productId", async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.productId, isArchived: false });
    if (!product) {
      req.session.error = "Product not found.";
      return res.redirect("/customer/shop");
    }
    res.render("customer/productDetail", { title: product.name, active: "shop", product });
  } catch (err) {
    console.error("❌ Product detail error:", err.message);
    req.session.error = "Failed to load product.";
    res.redirect("/customer/shop");
  }
});

// ==================== CART ====================
router.get("/cart", async (req, res) => {
  try {
    const cartItems = await Cart.find({
      userId: req.session.user._id,
      status: "active",
      isArchived: false,
    }).populate("productId");

    res.render("customer/cart", { title: "My Cart", active: "cart", cartItems });
  } catch (err) {
    console.error("❌ Cart error:", err.message);
    req.session.error = "Failed to load cart.";
    res.redirect("/customer/shop");
  }
});

// POST - Add to cart
router.post("/cart/add", async (req, res) => {
  try {
    const { productId, quantity, selectedSize, selectedColor, customText } = req.body;

    const product = await Product.findById(productId);
    if (!product || product.isArchived) {
      req.session.error = "Product not found.";
      return res.redirect("/customer/shop");
    }

    const qty = parseInt(quantity) || 1;
    const totalPrice = product.basePrice * qty;

    // Handle custom image upload
    let customImageUrl = null;
    if (req.files && req.files.length > 0) {
      customImageUrl = req.files[0].path;
    }

    await Cart.create({
      userId: req.session.user._id,
      productId,
      quantity: qty,
      selectedSize: selectedSize || null,
      selectedColor: selectedColor || null,
      customText: customText || null,
      customImageUrl,
      totalPrice,
    });

    req.session.success = "Item added to cart!";
    res.redirect("/customer/cart");
  } catch (err) {
    console.error("❌ Add to cart error:", err.message);
    req.session.error = "Failed to add item to cart.";
    res.redirect("back");
  }
});



// POST - Update cart quantity
router.post("/cart/:cartId/update", async (req, res) => {
  try {
    const cart = await Cart.findById(req.params.cartId).populate("productId");
    if (!cart || cart.userId.toString() !== req.session.user._id.toString()) {
      req.session.error = "Cart item not found.";
      return res.redirect("/customer/cart");
    }

    if (req.body.action === "increase") {
      if (cart.quantity < cart.productId.stock) cart.quantity += 1;
    } else if (req.body.action === "decrease") {
      if (cart.quantity > 1) cart.quantity -= 1;
    }

    cart.totalPrice = cart.productId.basePrice * cart.quantity;
    await cart.save();

    res.redirect("/customer/cart");
  } catch (err) {
    console.error("❌ Cart update error:", err.message);
    req.session.error = "Failed to update cart.";
    res.redirect("/customer/cart");
  }
});

// POST - Remove from cart
router.post("/cart/:cartId/remove", async (req, res) => {
  try {
    const cart = await Cart.findById(req.params.cartId);
    if (cart && cart.userId.toString() === req.session.user._id.toString()) {
      cart.isArchived = true;
      cart.status = "checked_out";
      await cart.save();
    }
    req.session.success = "Item removed from cart.";
    res.redirect("/customer/cart");
  } catch (err) {
    console.error("❌ Cart remove error:", err.message);
    req.session.error = "Failed to remove item.";
    res.redirect("/customer/cart");
  }
});

// ==================== CHECKOUT ====================
router.get("/checkout", async (req, res) => {
  try {
    const cartItems = await Cart.find({
      userId: req.session.user._id,
      status: "active",
      isArchived: false,
    }).populate("productId");

    if (cartItems.length === 0) {
      req.session.warning = "Your cart is empty.";
      return res.redirect("/customer/cart");
    }

    res.render("customer/checkout", { title: "Checkout", active: "cart", cartItems });
  } catch (err) {
    console.error("❌ Checkout error:", err.message);
    req.session.error = "Failed to load checkout.";
    res.redirect("/customer/cart");
  }
});

// POST - Place order
router.post("/checkout", async (req, res) => {
  try {
    const { shippingAddress, contactNumber, notes } = req.body;
    const userId = req.session.user._id;

    // Get active cart items
    const cartItems = await Cart.find({
      userId,
      status: "active",
      isArchived: false,
    }).populate("productId");

    if (cartItems.length === 0) {
      req.session.warning = "Your cart is empty.";
      return res.redirect("/customer/cart");
    }

    // Calculate total
    let totalAmount = 0;
    cartItems.forEach((item) => (totalAmount += item.totalPrice));

    // Generate order number
    const orderNumber = `KDY-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

    // Create order
    const order = await Order.create({
      userId,
      orderNumber,
      totalAmount,
      shippingAddress,
      contactNumber,
      notes: notes || null,
    });

    // Create order items from cart
    for (const item of cartItems) {
      await OrderItem.create({
        orderId: order._id,
        productId: item.productId._id,
        quantity: item.quantity,
        itemPrice: item.productId.basePrice,
        selectedSize: item.selectedSize,
        selectedColor: item.selectedColor,
        customText: item.customText,
        customImageUrl: item.customImageUrl,
        subtotal: item.totalPrice,
      });

      // Reduce stock
      await Product.findByIdAndUpdate(item.productId._id, {
        $inc: { stock: -item.quantity },
      });

      // Mark cart item as checked out
      item.status = "checked_out";
      item.isArchived = true;
      await item.save();
    }

    // Handle supporting file uploads
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        await UploadedFile.create({
          userId,
          orderId: order._id,
          fileName: file.originalname,
          fileUrl: file.path,
          fileType: file.mimetype.split("/")[1] || "unknown",
          fileSize: file.size,
        });
      }
    }

    // Create notification
    await Notification.create({
      userId,
      title: "Order Placed Successfully!",
      message: `Your order #${orderNumber} has been placed. We'll update you on the progress!`,
      type: "order_update",
    });

    req.session.success = `Order #${orderNumber} placed successfully!`;
    res.redirect(`/customer/orders/${order._id}`);
  } catch (err) {
    console.error("❌ Checkout error:", err.message);
    req.session.error = "Failed to place order. Please try again.";
    res.redirect("/customer/checkout");
  }
});

// ==================== ORDERS ====================
router.get("/orders", async (req, res) => {
  try {
    const { status } = req.query;
    const filter = { userId: req.session.user._id, isArchived: false };
    if (status) filter.status = status;

    const orders = await Order.find(filter).sort({ createdAt: -1 });

    res.render("customer/orders", {
      title: "My Orders",
      active: "orders",
      orders,
      statusFilter: status || "",
    });
  } catch (err) {
    console.error("❌ Orders error:", err.message);
    req.session.error = "Failed to load orders.";
    res.redirect("/customer/shop");
  }
});

// GET - Order detail
router.get("/orders/:orderId", async (req, res) => {
  try {
    const order = await Order.findOne({
      _id: req.params.orderId,
      userId: req.session.user._id,
      isArchived: false,
    });

    if (!order) {
      req.session.error = "Order not found.";
      return res.redirect("/customer/orders");
    }

    const orderItems = await OrderItem.find({ orderId: order._id, isArchived: false }).populate("productId");
    const shipping = await Shipping.findOne({ orderId: order._id, isArchived: false });
    const uploadedFiles = await UploadedFile.find({ orderId: order._id, isArchived: false });

    res.render("customer/orderDetail", {
      title: `Order #${order.orderNumber}`,
      active: "orders",
      order,
      orderItems,
      shipping,
      uploadedFiles,
    });
  } catch (err) {
    console.error("❌ Order detail error:", err.message);
    req.session.error = "Failed to load order details.";
    res.redirect("/customer/orders");
  }
});

// ==================== NOTIFICATIONS ====================
router.get("/notifications", async (req, res) => {
  try {
    const notifications = await Notification.find({
      userId: req.session.user._id,
      isArchived: false,
    }).sort({ createdAt: -1 });

    res.render("customer/notifications", {
      title: "Notifications",
      active: "notifications",
      notifications,
    });
  } catch (err) {
    console.error("❌ Notifications error:", err.message);
    req.session.error = "Failed to load notifications.";
    res.redirect("/customer/shop");
  }
});

// POST - Mark notification as read
router.post("/notifications/:notificationId/read", async (req, res) => {
  try {
    await Notification.findOneAndUpdate(
      { _id: req.params.notificationId, userId: req.session.user._id },
      { isRead: true }
    );
    res.redirect("/customer/notifications");
  } catch (err) {
    console.error("❌ Notification read error:", err.message);
    res.redirect("/customer/notifications");
  }
});

// POST - Mark all as read
router.post("/notifications/read-all", async (req, res) => {
  try {
    await Notification.updateMany(
      { userId: req.session.user._id, isRead: false },
      { isRead: true }
    );
    req.session.success = "All notifications marked as read.";
    res.redirect("/customer/notifications");
  } catch (err) {
    console.error("❌ Mark all read error:", err.message);
    res.redirect("/customer/notifications");
  }
});

// ==================== PROFILE ====================
router.get("/profile", async (req, res) => {
  try {
    const profile = await User.findById(req.session.user._id).select("-password");
    res.render("customer/profile", { title: "My Profile", active: "profile", profile });
  } catch (err) {
    console.error("❌ Profile error:", err.message);
    req.session.error = "Failed to load profile.";
    res.redirect("/customer/shop");
  }
});

// POST - Update profile
router.post("/profile/update", async (req, res) => {
  try {
    const { firstName, lastName, phoneNumber, address } = req.body;

    const updated = await User.findByIdAndUpdate(
      req.session.user._id,
      { firstName, lastName, phoneNumber, address },
      { new: true }
    ).select("-password");

    // Update session
    req.session.user = updated.toObject();
    req.session.success = "Profile updated successfully!";
    res.redirect("/customer/profile");
  } catch (err) {
    console.error("❌ Profile update error:", err.message);
    req.session.error = "Failed to update profile.";
    res.redirect("/customer/profile");
  }
});

// POST - Update profile photo
router.post("/profile/photo", async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      req.session.error = "No image selected.";
      return res.redirect("/customer/profile");
    }

    const imageUrl = req.files[0].path;
    const updated = await User.findByIdAndUpdate(
      req.session.user._id,
      { profileImage: imageUrl },
      { new: true }
    ).select("-password");

    req.session.user = updated.toObject();
    req.session.success = "Profile photo updated!";
    res.redirect("/customer/profile");
  } catch (err) {
    console.error("❌ Photo upload error:", err.message);
    req.session.error = "Failed to update photo.";
    res.redirect("/customer/profile");
  }
});

// POST - Change password
router.post("/profile/password", async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmNewPassword } = req.body;

    if (newPassword !== confirmNewPassword) {
      req.session.error = "New passwords do not match.";
      return res.redirect("/customer/profile");
    }

    if (newPassword.length < 6) {
      req.session.error = "New password must be at least 6 characters.";
      return res.redirect("/customer/profile");
    }

    const user = await User.findById(req.session.user._id);
    const isMatch = await bcrypt.compare(currentPassword, user.password);

    if (!isMatch) {
      req.session.error = "Current password is incorrect.";
      return res.redirect("/customer/profile");
    }

    user.password = await bcrypt.hash(newPassword, 12);
    await user.save();

    req.session.success = "Password changed successfully!";
    res.redirect("/customer/profile");
  } catch (err) {
    console.error("❌ Password change error:", err.message);
    req.session.error = "Failed to change password.";
    res.redirect("/customer/profile");
  }
});

// POST - Cancel Order
router.post("/orders/:orderId/cancel", async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.session.user._id;

    const order = await Order.findOne({
      _id: orderId,
      userId,
      isArchived: false,
    });

    if (!order) {
      req.session.error = "Order not found.";
      return res.redirect("/customer/orders");
    }

    // Only allow cancellation if still pending or processing
    if (!["pending", "processing"].includes(order.status)) {
      req.session.error = "Order cannot be cancelled anymore.";
      return res.redirect(`/customer/orders/${orderId}`);
    }

    // Update order status
    order.status = "cancelled";
    await order.save();

    // Get order items
    const orderItems = await OrderItem.find({
      orderId: order._id,
      isArchived: false,
    });

    for (const item of orderItems) {
      // Restore stock
      await Product.findByIdAndUpdate(item.productId, {
        $inc: { stock: item.quantity },
      });

      // Update item status
      item.status = "cancelled";
      await item.save();
    }

    // Create notification
    await Notification.create({
      userId,
      title: "Order Cancelled",
      message: `Your order #${order.orderNumber} has been cancelled successfully.`,
      type: "order_update",
    });

    req.session.success = `Order #${order.orderNumber} cancelled successfully.`;
    res.redirect(`/customer/orders/${orderId}`);
  } catch (err) {
    console.error("❌ Cancel order error:", err.message);
    req.session.error = "Failed to cancel order.";
    res.redirect("/customer/orders");
  }
});


module.exports = router;
