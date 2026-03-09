const OrderItem = require("../models/OrderItem");
const Order = require("../models/Order");

const isOrderItem = async (req, res, next) => {
  try {
    const { orderItemId } = req.params;

    if (!orderItemId) {
      req.session.error = "Order item ID is required.";
      return res.redirect("back");
    }

    const orderItem = await OrderItem.findById(orderItemId);

    if (!orderItem || orderItem.isArchived) {
      req.session.error = "Order item not found or has been archived.";
      return res.redirect("back");
    }

    // Verify ownership through the parent order
    // Customer can only access items from their own orders
    if (req.session.user.role === "customer") {
      const parentOrder = await Order.findById(orderItem.orderId);

      if (
        !parentOrder ||
        parentOrder.userId.toString() !== req.session.user._id.toString()
      ) {
        req.session.denied = "Access denied. You can only view your own order items.";
        return res.redirect("back");
      }
    }

    req.orderItem = orderItem;
    next();
  } catch (err) {
    console.error("❌ isOrderItem middleware error:", err.message);
    req.session.error = "Something went wrong while validating the order item.";
    return res.redirect("back");
  }
};

module.exports = isOrderItem;
