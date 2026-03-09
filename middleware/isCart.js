const Cart = require("../models/Cart");

const isCart = async (req, res, next) => {
  try {
    const { cartId } = req.params;

    if (!cartId) {
      req.session.error = "Cart ID is required.";
      return res.redirect("back");
    }

    const cart = await Cart.findById(cartId);

    if (!cart || cart.isArchived) {
      req.session.error = "Cart item not found or has been archived.";
      return res.redirect("back");
    }

    // Customer can only access their own cart
    // Admin can access any cart
    if (
      req.session.user.role === "customer" &&
      cart.userId.toString() !== req.session.user._id.toString()
    ) {
      req.session.denied = "Access denied. You can only manage your own cart.";
      return res.redirect("back");
    }

    req.cart = cart;
    next();
  } catch (err) {
    console.error("❌ isCart middleware error:", err.message);
    req.session.error = "Something went wrong while validating the cart.";
    return res.redirect("back");
  }
};

module.exports = isCart;
