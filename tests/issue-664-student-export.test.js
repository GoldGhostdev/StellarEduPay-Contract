'use strict';

/**
 * Tests for Issue #664 — GET /api/students/export
 * Tests the exportStudents controller directly (no app.js required).
 */

jest.mock('csv-parser', () => jest.fn(), { virtual: true });
jest.mock('multer', () => { const m = () => ({ single: () => (r, s, n) => n() }); m.memoryStorage = jest.fn(); return m; }, { virtual: true });

jest.mock('../backend/src/utils/logger', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  log.child = () => log;
  return log;
});

jest.mock('../backend/src/cache', () => ({
  get: jest.fn().mockReturnValue(undefined),
  set: jest.fn(),
  del: jest.fn(),
  KEYS: { student: (id) => `student:${id}`, studentsAll: () => 'students:all' },
  TTL: { STUDENT: 60 },
}));

jest.mock('../backend/src/services/auditService', () => ({ logAudit: jest.fn() }));
jest.mock('../backend/src/models/feeStructureModel');
jest.mock('../backend/src/models/studentModel');

// ── Helpers ───────────────────────────────────────────────────────────────────

const { EventEmitter } = require('events');

function makeCursor(docs) {
  const emitter = new EventEmitter();
  setImmediate(() => {
    docs.forEach((d) => emitter.emit('data', d));
    emitter.emit('end');
  });
  return emitter;
}

function makeRes() {
  const chunks = [];
  const res = {
    _headers: {},
    _status: null,
    _body: null,
    setHeader: jest.fn(function (k, v) { this._headers[k] = v; }),
    write: jest.fn(function (chunk) { chunks.push(chunk); }),
    end: jest.fn(),
    status: jest.fn(function (code) { this._status = code; return this; }),
    json: jest.fn(function (body) { this._body = body; return this; }),
    get text() { return chunks.join(''); },
  };
  return res;
}

function makeReq(query = {}) {
  return { schoolId: 'SCH001', query };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('exportStudents — Issue #664', () => {
  let Student;
  let exportStudents;

  const mockStudents = [
    { studentId: 'STU001', name: 'Alice', class: '5A', feeAmount: 200, totalPaid: 200, remainingBalance: 0, feePaid: true, createdAt: new Date('2026-01-01T00:00:00.000Z'), deletedAt: null },
    { studentId: 'STU002', name: 'Bob', class: '5B', feeAmount: 250, totalPaid: 0, remainingBalance: 250, feePaid: false, createdAt: new Date('2026-01-02T00:00:00.000Z'), deletedAt: null },
  ];

  const mockDeletedStudent = {
    studentId: 'STU003', name: 'Charlie', class: '5A', feeAmount: 200, totalPaid: 0, remainingBalance: 200, feePaid: false,
    createdAt: new Date('2026-01-03T00:00:00.000Z'), deletedAt: new Date('2026-03-01T00:00:00.000Z'),
  };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    Student = require('../backend/src/models/studentModel');
    ({ exportStudents } = require('../backend/src/controllers/studentController'));
  });

  function setupCursor(docs) {
    Student.find = jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({ cursor: () => makeCursor(docs) }),
    });
  }

  function runExport(req, res) {
    return new Promise((resolve, reject) => {
      res.end.mockImplementation(resolve);
      res.json.mockImplementation(() => resolve());
      exportStudents(req, res, reject);
    });
  }

  test('sets Content-Type: text/csv', async () => {
    setupCursor(mockStudents);
    const res = makeRes();
    await runExport(makeReq(), res);
    expect(res._headers['Content-Type']).toBe('text/csv');
  });

  test('sets Content-Disposition with ISO date filename', async () => {
    setupCursor(mockStudents);
    const res = makeRes();
    await runExport(makeReq(), res);
    expect(res._headers['Content-Disposition']).toMatch(/^attachment; filename="students-\d{4}-\d{2}-\d{2}\.csv"$/);
  });

  test('writes correct CSV header row', async () => {
    setupCursor([]);
    const res = makeRes();
    await runExport(makeReq(), res);
    const lines = res.text.split('\n').filter(Boolean);
    expect(lines[0]).toBe('studentId,name,class,feeAmount,totalPaid,remainingBalance,feePaid,createdAt');
  });

  test('streams one data row per student', async () => {
    setupCursor(mockStudents);
    const res = makeRes();
    await runExport(makeReq(), res);
    const lines = res.text.split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('STU001');
    expect(lines[2]).toContain('STU002');
  });

  test('excludes soft-deleted students by default', async () => {
    setupCursor(mockStudents);
    const res = makeRes();
    await runExport(makeReq(), res);
    expect(Student.find).toHaveBeenCalledWith(expect.objectContaining({ deletedAt: null }));
  });

  test('includes deletedAt column when ?includeDeleted=true', async () => {
    setupCursor([...mockStudents, mockDeletedStudent]);
    const res = makeRes();
    await runExport(makeReq({ includeDeleted: 'true' }), res);
    const lines = res.text.split('\n').filter(Boolean);
    expect(lines[0]).toContain('deletedAt');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toContain('STU003');
  });

  test('does not filter deletedAt when ?includeDeleted=true', async () => {
    setupCursor([]);
    const res = makeRes();
    await runExport(makeReq({ includeDeleted: 'true' }), res);
    expect(Student.find.mock.calls[0][0]).not.toHaveProperty('deletedAt');
  });

  test('filters by class query parameter', async () => {
    setupCursor([mockStudents[0]]);
    const res = makeRes();
    await runExport(makeReq({ class: '5A' }), res);
    expect(Student.find).toHaveBeenCalledWith(expect.objectContaining({ class: '5A' }));
  });

  test('filters by status=paid', async () => {
    setupCursor([mockStudents[0]]);
    const res = makeRes();
    await runExport(makeReq({ status: 'paid' }), res);
    expect(Student.find).toHaveBeenCalledWith(expect.objectContaining({ feePaid: true }));
  });

  test('filters by status=unpaid', async () => {
    setupCursor([mockStudents[1]]);
    const res = makeRes();
    await runExport(makeReq({ status: 'unpaid' }), res);
    expect(Student.find).toHaveBeenCalledWith(expect.objectContaining({ feePaid: false }));
  });

  test('filters by status=partial', async () => {
    setupCursor([]);
    const res = makeRes();
    await runExport(makeReq({ status: 'partial' }), res);
    expect(Student.find).toHaveBeenCalledWith(expect.objectContaining({ feePaid: false, totalPaid: { $gt: 0 } }));
  });

  test('returns 400 for invalid status', async () => {
    const res = makeRes();
    const next = jest.fn();
    await exportStudents(makeReq({ status: 'invalid' }), res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  test('streams header-only CSV when no students match', async () => {
    setupCursor([]);
    const res = makeRes();
    await runExport(makeReq(), res);
    const lines = res.text.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('studentId,name,class,feeAmount,totalPaid,remainingBalance,feePaid,createdAt');
  });

  test('quotes CSV fields containing commas', async () => {
    setupCursor([{ ...mockStudents[0], name: 'Smith, John' }]);
    const res = makeRes();
    await runExport(makeReq(), res);
    const lines = res.text.split('\n').filter(Boolean);
    expect(lines[1]).toContain('"Smith, John"');
  });
});
