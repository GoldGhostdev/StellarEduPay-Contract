'use strict';

/**
 * Tests for issue #797 — bulk import uses insertMany (batched), not sequential inserts.
 */

jest.mock('csv-parser', () => jest.fn(), { virtual: true });

const mockInsertMany = jest.fn();
const mockCountDocuments = jest.fn().mockResolvedValue(0);

jest.mock('../backend/src/models/studentModel', () => ({
  insertMany: (...a) => mockInsertMany(...a),
  countDocuments: (...a) => mockCountDocuments(...a),
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
}));

jest.mock('../backend/src/models/feeStructureModel', () => ({
  find: jest.fn().mockReturnValue({
    lean: jest.fn().mockResolvedValue([{ className: 'Grade1', feeAmount: 500 }]),
  }),
  findOne: jest.fn().mockResolvedValue({ feeAmount: 500 }),
}));

jest.mock('../backend/src/models/schoolModel', () => ({
  findOne: jest.fn().mockResolvedValue({ schoolId: 'SCH1', maxStudents: null }),
}));

jest.mock('../backend/src/services/auditService', () => ({ logAudit: jest.fn() }));
jest.mock('../backend/src/cache', () => ({
  get: jest.fn(), set: jest.fn(), del: jest.fn(),
  KEYS: { studentsAll: () => 'all', student: (id) => id },
  TTL: { STUDENT: 60 },
}));
jest.mock('../backend/src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
  child: jest.fn().mockReturnThis(),
}));

const { bulkImportStudents } = require('../backend/src/controllers/studentController');

function makeReq(students) {
  return { schoolId: 'SCH1', body: { students }, file: null, auditContext: null };
}
function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
function generateRows(n) {
  return Array.from({ length: n }, (_, i) => ({
    studentId: `STU${String(i + 1).padStart(7, '0')}`,
    name: `Student ${i + 1}`,
    class: 'Grade1',
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockInsertMany.mockImplementation((docs) =>
    Promise.resolve(docs.map((d, i) => ({ ...d, _id: `id_${i}` })))
  );
  mockCountDocuments.mockResolvedValue(0);
});

describe('#797 — bulk import uses insertMany, not sequential inserts', () => {
  it('5000 rows: calls insertMany in ≤10 chunks with ordered:false', async () => {
    const rows = generateRows(5000);
    const req = makeReq(rows);
    const res = makeRes();

    await bulkImportStudents(req, res, jest.fn());

    expect(mockInsertMany).toHaveBeenCalled();
    // CHUNK_SIZE=500 → at most 10 calls for 5000 rows
    expect(mockInsertMany.mock.calls.length).toBeLessThanOrEqual(10);
    mockInsertMany.mock.calls.forEach(([, opts]) => {
      expect(opts).toEqual(expect.objectContaining({ ordered: false }));
    });
    const result = res.json.mock.calls[0][0];
    expect(result.created).toBe(5000);
    expect(result.failed).toBe(0);
  });

  it('per-row validation errors reported without aborting the batch', async () => {
    const rows = generateRows(5);
    rows[2].studentId = ''; // invalid
    const req = makeReq(rows);
    const res = makeRes();

    await bulkImportStudents(req, res, jest.fn());

    const result = res.json.mock.calls[0][0];
    expect(result.failed).toBe(1);
    expect(result.created).toBe(4);
    const failRow = result.details.find(d => d.error);
    expect(failRow.code).toBe('VALIDATION_ERROR');
  });

  it('duplicate key errors from insertMany reported per-row', async () => {
    const rows = generateRows(2);
    const req = makeReq(rows);
    const res = makeRes();

    const bulkErr = new Error('BulkWriteError');
    bulkErr.insertedDocs = [{ studentId: rows[0].studentId, _id: 'id0' }];
    bulkErr.writeErrors = [{ index: 1, err: { code: 11000, message: 'E11000' } }];
    mockInsertMany.mockRejectedValueOnce(bulkErr);

    await bulkImportStudents(req, res, jest.fn());

    const result = res.json.mock.calls[0][0];
    expect(result.created).toBe(1);
    const dup = result.details.find(d => d.code === 'DUPLICATE_STUDENT_ID');
    expect(dup).toBeDefined();
  });
});
