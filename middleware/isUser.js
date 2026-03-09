const User = require("../models/User");

const isUser = async (req, res, next) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      req.session.error = "User ID is required.";
      return res.redirect("back");
    }

    const user = await User.findById(userId);

    if (!user || user.isArchived) {
      req.session.error = "User not found or has been archived.";
      return res.redirect("back");
    }

    // If customer, can only access their own profile
    // Admin can access any user
    if (
      req.session.user.role === "customer" &&
      user._id.toString() !== req.session.user._id.toString()
    ) {
      req.session.denied = "Access denied. You can only view your own profile.";
      return res.redirect("back");
    }

    req.foundUser = user;
    next();
  } catch (err) {
    console.error("❌ isUser middleware error:", err.message);
    req.session.error = "Something went wrong while validating the user.";
    return res.redirect("back");
  }
};

module.exports = isUser;
