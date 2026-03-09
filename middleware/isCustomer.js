const isCustomer = (req, res, next) => {
  try {
    if (!req.session || !req.session.user) {
      req.session.error = "You must be logged in to access this page.";
      return res.redirect("/");
    }

    if (req.session.user.role !== "customer") {
      req.session.denied = "Access denied. This page is for customers only.";
      return res.redirect("back");
    }

    next();
  } catch (err) {
    console.error("❌ isCustomer middleware error:", err.message);
    req.session.error = "Something went wrong while verifying customer access.";
    return res.redirect("/");
  }
};

module.exports = isCustomer;
