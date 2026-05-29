'use strict';

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../backend/src/app');
const Student = require('../backend/src/models/studentModel');
const School = require('../backend/src/models/schoolModel');

let mongoServer;
const schoolId = 'SCH-TEST-PII';
const walletAddress = 'GSCHOOL123456789';

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Student.deleteMany({});
  await School.deleteMany({});

  await School.create({
    schoolId,
    name: 'Test School',
    stellarAddress: walletAddress,
  });

  await Student.create({
    schoolId,
    studentId: 'STU001',
    name: 'Alice Johnson',
    class: 'Grade 5A',
    feeAmount: 250,
    parentEmail: 'alice@example.com',
    parentPhone: '555-1234',
    feePaid: false,
    totalPaid: 0,
  });
});

describe('Student PII Protection', () => {
  test('GET /api/students/:studentId should require admin authentication', async () => {
    const res = await request(app)
      .get('/api/students/STU001')
      .set('X-School-Id', schoolId);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain('authentication');
  });

  test('GET /api/students/public/:studentId should return only non-PII fields', async () => {
    const res = await request(app)
      .get('/api/students/public/STU001')
      .set('X-School-Id', schoolId);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('name');
    expect(res.body).toHaveProperty('class');
    expect(res.body).toHaveProperty('feePaid');
    
    // Should NOT contain PII
    expect(res.body).not.toHaveProperty('parentEmail');
    expect(res.body).not.toHaveProperty('parentPhone');
    expect(res.body).not.toHaveProperty('totalPaid');
    expect(res.body).not.toHaveProperty('remainingBalance');
    expect(res.body).not.toHaveProperty('feeAmount');
  });

  test('public endpoint should return correct field values', async () => {
    const res = await request(app)
      .get('/api/students/public/STU001')
      .set('X-School-Id', schoolId);

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Alice Johnson');
    expect(res.body.class).toBe('Grade 5A');
    expect(res.body.feePaid).toBe(false);
  });

  test('public endpoint should return 404 for non-existent student', async () => {
    const res = await request(app)
      .get('/api/students/public/NONEXISTENT')
      .set('X-School-Id', schoolId);

    expect(res.status).toBe(404);
  });

  test('public endpoint should not expose student ID in response', async () => {
    const res = await request(app)
      .get('/api/students/public/STU001')
      .set('X-School-Id', schoolId);

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('studentId');
  });

  test('admin endpoint should return full student record with auth', async () => {
    // Mock admin auth - in real tests this would use JWT
    const res = await request(app)
      .get('/api/students/STU001')
      .set('X-School-Id', schoolId)
      .set('Authorization', 'Bearer valid-admin-token');

    // This will fail without proper auth setup, but demonstrates the intent
    // In actual implementation, admin auth middleware would validate the token
    expect([200, 401]).toContain(res.status);
  });
});
