'use strict';

const EmailDelivery = require('../models/emailDeliveryModel');

async function getEmailDeliveriesForStudent(req, res, next) {
  try {
    const { schoolId } = req;
    const { studentId } = req.params;

    const deliveries = await EmailDelivery.find({ schoolId, studentId }).sort({ createdAt: -1 }).lean();
    res.json({ studentId, deliveries });
  } catch (err) {
    next(err);
  }
}

module.exports = { getEmailDeliveriesForStudent };
