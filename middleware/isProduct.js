const Product = require("../models/Product");

const isProduct = async (req, res, next) => {
  try {
    const { productId } = req.params;

    if (!productId) {
      req.session.error = "Product ID is required.";
      return res.redirect("back");
    }

    const product = await Product.findById(productId);

    if (!product || product.isArchived) {
      req.session.error = "Product not found or has been archived.";
      return res.redirect("back");
    }

    req.product = product;
    next();
  } catch (err) {
    console.error("❌ isProduct middleware error:", err.message);
    req.session.error = "Something went wrong while validating the product.";
    return res.redirect("back");
  }
};

module.exports = isProduct;
