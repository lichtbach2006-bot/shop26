const Notification = require("../models/Notification");

const isNotification = async (req, res, next) => {
  try {
    const { notificationId } = req.params;

    if (!notificationId) {
      req.session.error = "Notification ID is required.";
      return res.redirect("back");
    }

    const notification = await Notification.findById(notificationId);

    if (!notification || notification.isArchived) {
      req.session.error = "Notification not found or has been archived.";
      return res.redirect("back");
    }

    // Customer can only access their own notifications
    // Admin can access any notification
    if (
      req.session.user.role === "customer" &&
      notification.userId.toString() !== req.session.user._id.toString()
    ) {
      req.session.denied = "Access denied. You can only view your own notifications.";
      return res.redirect("back");
    }

    req.notification = notification;
    next();
  } catch (err) {
    console.error("❌ isNotification middleware error:", err.message);
    req.session.error = "Something went wrong while validating the notification.";
    return res.redirect("back");
  }
};

module.exports = isNotification;
