const isAdmin = (req, res, next) => {
  try {
    if (!req.session || !req.session.user) {
      req.session.error = "You must be logged in to access this page.";
      return res.redirect("/");
    }

    if (req.session.user.role !== "admin") {
      req.session.denied = "Access denied. Admin privileges required.";
      return res.redirect("back");
    }

    next();
  } catch (err) {
    console.error("❌ isAdmin middleware error:", err.message);
    req.session.error = "Something went wrong while verifying admin access.";
    return res.redirect("/");
  }
};

module.exports = isAdmin;
