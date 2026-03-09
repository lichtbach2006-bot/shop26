const Shipping = require("../models/Shipping");
const Order = require("../models/Order");

const isShipping = async (req, res, next) => {
  try {
    const { shippingId } = req.params;

    if (!shippingId) {
      req.session.error = "Shipping ID is required.";
      return res.redirect("back");
    }

    const shipping = await Shipping.findById(shippingId);

    if (!shipping || shipping.isArchived) {
      req.session.error = "Shipping record not found or has been archived.";
      return res.redirect("back");
    }

    // Verify ownership through the parent order
    // Customer can only track shipping for their own orders
    if (req.session.user.role === "customer") {
      const parentOrder = await Order.findById(shipping.orderId);

      if (
        !parentOrder ||
        parentOrder.userId.toString() !== req.session.user._id.toString()
      ) {
        req.session.denied = "Access denied. You can only track your own shipments.";
        return res.redirect("back");
      }
    }

    req.shipping = shipping;
    next();
  } catch (err) {
    console.error("❌ isShipping middleware error:", err.message);
    req.session.error = "Something went wrong while validating the shipping record.";
    return res.redirect("back");
  }
};

module.exports = isShipping;
