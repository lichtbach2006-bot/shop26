const Order = require("../models/Order");

const isOrder = async (req, res, next) => {
  try {
    const { orderId } = req.params;

    if (!orderId) {
      req.session.error = "Order ID is required.";
      return res.redirect("back");
    }

    const order = await Order.findById(orderId);

    if (!order || order.isArchived) {
      req.session.error = "Order not found or has been archived.";
      return res.redirect("back");
    }

    // Customer can only access their own orders
    // Admin can access any order (for processing, updating status, etc.)
    if (
      req.session.user.role === "customer" &&
      order.userId.toString() !== req.session.user._id.toString()
    ) {
      req.session.denied = "Access denied. You can only view your own orders.";
      return res.redirect("back");
    }

    req.order = order;
    next();
  } catch (err) {
    console.error("❌ isOrder middleware error:", err.message);
    req.session.error = "Something went wrong while validating the order.";
    return res.redirect("back");
  }
};

module.exports = isOrder;
