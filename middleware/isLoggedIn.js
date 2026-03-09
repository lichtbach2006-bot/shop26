const isLoggedIn = (req, res, next) => {
  try {
    if (!req.session || !req.session.user) {
      req.session.error = "You must be logged in to access this page.";
      return res.redirect("/");
    }

    // Check if user account is blocked
    if (req.session.user.status === "blocked") {
      req.session.destroy();
      return res.redirect("/");
    }

    next();
  } catch (err) {
    console.error("❌ isLoggedIn middleware error:", err.message);
    req.session.error = "Something went wrong. Please log in again.";
    return res.redirect("/");
  }
};

module.exports = isLoggedIn;
