'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const {
  registerStudent,
  getAllStudents,
  getStudent,
  getPublicStudentInfo,
  updateStudent,
  deleteStudent,
  getPaymentSummary,
  bulkImportStudents,
  getOverdueStudents,
  resetPayment,
  reconcileStudent,
} = require('../controllers/studentController');
const { resubscribeReminders } = require('../controllers/reminderController');
const { validateRegisterStudent, validateStudentIdParam } = require('../middleware/validate');
const { resolveSchool } = require('../middleware/schoolContext');
const { requireAdminAuth } = require('../middleware/auth');
const { auditContext } = require('../middleware/auditContext');
const { bulkImportLimiter } = require('../middleware/rateLimiter');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.use(resolveSchool);

// Admin-only routes
router.post('/', requireAdminAuth, validateRegisterStudent, registerStudent);
router.post('/bulk', requireAdminAuth, bulkImportLimiter, express.json({ limit: '1mb' }), upload.single('file'), bulkImportStudents);
router.get('/', requireAdminAuth, getAllStudents);

// Public routes
router.get('/summary', getPaymentSummary);
router.get('/overdue', getOverdueStudents);
router.get('/public/:studentId', validateStudentIdParam, getPublicStudentInfo);
router.get('/:studentId', requireAdminAuth, validateStudentIdParam, getStudent);
router.put('/:studentId', requireAdminAuth, validateStudentIdParam, updateStudent);
router.delete('/:studentId', requireAdminAuth, validateStudentIdParam, deleteStudent);
router.post('/:studentId/reset-payment', requireAdminAuth, validateStudentIdParam, resetPayment);
router.post('/:studentId/reconcile', requireAdminAuth, validateStudentIdParam, reconcileStudent);
router.post('/:studentId/reminders/resubscribe', requireAdminAuth, validateStudentIdParam, resubscribeReminders);

module.exports = router;
