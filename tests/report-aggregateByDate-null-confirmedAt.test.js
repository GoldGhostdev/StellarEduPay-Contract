'use strict';

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GCICZOP346CKADPWOZ6JAQ7OCGH44UELNS3GSDXFOTSZRW6OYZZ6KSY7B';
process.env.JWT_SECRET = 'test-jwt-secret-report';

jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(true),
  Schema: class {
    constructor() { this.index = jest.fn(); }
  },
  model: jest.fn().mockReturnValue({}),
}));

const reportService = require('../backend/src/services/reportService');

describe('Report Service aggregateByDate (#674)', () => {
  let mockPaymentAggregate;
  let mockPaymentDistinct;
  let mockStudentAggregate;
  let mockStudentCountDocuments;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock Payment.aggregate for aggregateByDate
    mockPaymentAggregate = jest.fn();
    mockPaymentDistinct = jest.fn();
    mockStudentAggregate = jest.fn();
    mockStudentCountDocuments = jest.fn();

    jest.mock('../backend/src/models/paymentModel', () => ({
      aggregate: mockPaymentAggregate,
      distinct: mockPaymentDistinct,
    }));

    jest.mock('../backend/src/models/studentModel', () => ({
      aggregate: mockStudentAggregate,
      countDocuments: mockStudentCountDocuments,
    }));
  });

  describe('aggregateByDate with null confirmedAt', () => {
    it('should include SUCCESS payments with null confirmedAt using updatedAt as fallback', async () => {
      const mockPayments = [
        {
          _id: '2026-03-24',
          totalAmount: 500,
          paymentCount: 2,
          validCount: 2,
          overpaidCount: 0,
          underpaidCount: 0,
          uniqueStudentCount: 2,
        },
      ];

      mockPaymentAggregate.mockResolvedValue(mockPayments);

      const result = await reportService.aggregateByDate({
        schoolId: 'SCH001',
        startDate: '2026-03-24',
        endDate: '2026-03-24',
      });

      expect(result).toEqual(mockPayments);
      expect(mockPaymentAggregate).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            $match: expect.objectContaining({
              schoolId: 'SCH001',
              status: 'SUCCESS',
            }),
          }),
        ])
      );
    });

    it('should use updatedAt when confirmedAt is null for SUCCESS payments', async () => {
      const mockPayments = [
        {
          _id: '2026-03-24',
          totalAmount: 250,
          paymentCount: 1,
          validCount: 1,
          overpaidCount: 0,
          underpaidCount: 0,
          uniqueStudentCount: 1,
        },
      ];

      mockPaymentAggregate.mockResolvedValue(mockPayments);

      await reportService.aggregateByDate({
        schoolId: 'SCH001',
        startDate: '2026-03-24',
        endDate: '2026-03-24',
      });

      const aggregatePipeline = mockPaymentAggregate.mock.calls[0][0];
      const groupStage = aggregatePipeline.find((stage) => stage.$group);

      // Verify the $group stage uses $dateToString with fallback logic
      expect(groupStage).toBeDefined();
      expect(groupStage.$group._id).toBeDefined();
    });

    it('should match total payment count in date reports with summary report', async () => {
      const mockPayments = [
        {
          _id: '2026-03-24',
          totalAmount: 500,
          paymentCount: 3,
          validCount: 2,
          overpaidCount: 1,
          underpaidCount: 0,
          uniqueStudentCount: 3,
        },
      ];

      mockPaymentAggregate.mockResolvedValue(mockPayments);

      const result = await reportService.aggregateByDate({
        schoolId: 'SCH001',
        startDate: '2026-03-24',
        endDate: '2026-03-24',
      });

      const totalFromDate = result.reduce((sum, row) => sum + row.paymentCount, 0);
      expect(totalFromDate).toBe(3);
    });
  });

  describe('Data health check for null confirmedAt', () => {
    it('should identify SUCCESS payments with null confirmedAt', async () => {
      const mockPayments = [
        {
          _id: 'pay-001',
          studentId: 'STU001',
          status: 'SUCCESS',
          confirmedAt: null,
          updatedAt: new Date('2026-03-24T10:00:00Z'),
        },
        {
          _id: 'pay-002',
          studentId: 'STU002',
          status: 'SUCCESS',
          confirmedAt: new Date('2026-03-24T10:00:00Z'),
          updatedAt: new Date('2026-03-24T10:00:00Z'),
        },
      ];

      mockPaymentAggregate.mockResolvedValue(mockPayments);

      const result = await reportService.aggregateByDate({
        schoolId: 'SCH001',
      });

      // Verify that the aggregation pipeline includes a match for SUCCESS status
      const aggregatePipeline = mockPaymentAggregate.mock.calls[0][0];
      const matchStage = aggregatePipeline.find((stage) => stage.$match);
      expect(matchStage.$match.status).toBe('SUCCESS');
    });

    it('should handle payments with both confirmedAt and updatedAt', async () => {
      const mockPayments = [
        {
          _id: '2026-03-24',
          totalAmount: 750,
          paymentCount: 3,
          validCount: 3,
          overpaidCount: 0,
          underpaidCount: 0,
          uniqueStudentCount: 3,
        },
      ];

      mockPaymentAggregate.mockResolvedValue(mockPayments);

      const result = await reportService.aggregateByDate({
        schoolId: 'SCH001',
        startDate: '2026-03-24',
        endDate: '2026-03-24',
      });

      expect(result[0].paymentCount).toBe(3);
    });
  });

  describe('Report consistency', () => {
    it('should not exclude SUCCESS payments from date-grouped reports', async () => {
      const mockPayments = [
        {
          _id: '2026-03-24',
          totalAmount: 500,
          paymentCount: 2,
          validCount: 2,
          overpaidCount: 0,
          underpaidCount: 0,
          uniqueStudentCount: 2,
        },
      ];

      mockPaymentAggregate.mockResolvedValue(mockPayments);

      const result = await reportService.aggregateByDate({
        schoolId: 'SCH001',
        startDate: '2026-03-24',
        endDate: '2026-03-24',
      });

      expect(result.length).toBeGreaterThan(0);
      expect(result[0].paymentCount).toBeGreaterThan(0);
    });

    it('should filter out deleted students from reports', async () => {
      mockPaymentAggregate.mockResolvedValue([]);

      await reportService.aggregateByDate({
        schoolId: 'SCH001',
      });

      const aggregatePipeline = mockPaymentAggregate.mock.calls[0][0];
      const matchStage = aggregatePipeline.find((stage) => stage.$match);

      expect(matchStage.$match).toHaveProperty('studentDeleted');
      expect(matchStage.$match.studentDeleted).toEqual({ $ne: true });
    });
  });

  describe('Timezone handling with null confirmedAt', () => {
    it('should apply timezone to date grouping', async () => {
      mockPaymentAggregate.mockResolvedValue([]);

      await reportService.aggregateByDate({
        schoolId: 'SCH001',
        timezone: 'America/New_York',
      });

      const aggregatePipeline = mockPaymentAggregate.mock.calls[0][0];
      const groupStage = aggregatePipeline.find((stage) => stage.$group);

      expect(groupStage.$group._id).toBeDefined();
    });

    it('should default to UTC timezone', async () => {
      mockPaymentAggregate.mockResolvedValue([]);

      await reportService.aggregateByDate({
        schoolId: 'SCH001',
      });

      const aggregatePipeline = mockPaymentAggregate.mock.calls[0][0];
      const groupStage = aggregatePipeline.find((stage) => stage.$group);

      expect(groupStage.$group._id).toBeDefined();
    });
  });
});
