'use strict';

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import Dashboard from '../frontend/src/pages/dashboard';
import * as api from '../frontend/src/services/api';

jest.mock('../frontend/src/services/api');
jest.mock('../frontend/src/components/SyncButton', () => {
  return function MockSyncButton() {
    return <div data-testid="sync-button">Sync Button</div>;
  };
});
jest.mock('../frontend/src/components/ErrorBoundary', () => {
  return function MockErrorBoundary({ children }) {
    return <div data-testid="error-boundary">{children}</div>;
  };
});
jest.mock('../frontend/src/components/StudentForm', () => {
  return function MockStudentForm() {
    return <div data-testid="student-form">Student Form</div>;
  };
});

describe('Dashboard Error Handling (#672)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Network error handling', () => {
    it('should display error banner when API call fails', async () => {
      api.getSyncStatus.mockRejectedValue(new Error('Network error'));
      api.getPaymentSummary.mockRejectedValue(new Error('Network error'));
      api.getStudents.mockRejectedValue(new Error('Network error'));

      render(<Dashboard />);

      await waitFor(() => {
        expect(screen.queryByText(/Could not load dashboard/i)).toBeInTheDocument();
      });
    });

    it('should show user-friendly error message on network failure', async () => {
      api.getSyncStatus.mockRejectedValue(new Error('Network error'));
      api.getPaymentSummary.mockRejectedValue(new Error('Network error'));
      api.getStudents.mockRejectedValue(new Error('Network error'));

      render(<Dashboard />);

      await waitFor(() => {
        expect(
          screen.queryByText(/There was a problem connecting to the server/i)
        ).toBeInTheDocument();
      });
    });

    it('should display error banner on 503 Service Unavailable', async () => {
      const error = new Error('Service Unavailable');
      error.response = { status: 503 };
      api.getSyncStatus.mockRejectedValue(error);
      api.getPaymentSummary.mockRejectedValue(error);
      api.getStudents.mockRejectedValue(error);

      render(<Dashboard />);

      await waitFor(() => {
        expect(screen.queryByText(/Could not load dashboard/i)).toBeInTheDocument();
      });
    });

    it('should display error banner on timeout', async () => {
      const error = new Error('Request timeout');
      error.code = 'ECONNABORTED';
      api.getSyncStatus.mockRejectedValue(error);
      api.getPaymentSummary.mockRejectedValue(error);
      api.getStudents.mockRejectedValue(error);

      render(<Dashboard />);

      await waitFor(() => {
        expect(screen.queryByText(/Could not load dashboard/i)).toBeInTheDocument();
      });
    });
  });

  describe('Error banner UI', () => {
    it('should include a Retry button in error banner', async () => {
      api.getSyncStatus.mockRejectedValue(new Error('Network error'));
      api.getPaymentSummary.mockRejectedValue(new Error('Network error'));
      api.getStudents.mockRejectedValue(new Error('Network error'));

      render(<Dashboard />);

      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /retry/i })).toBeInTheDocument();
      });
    });

    it('should re-fetch data when Retry button is clicked', async () => {
      api.getSyncStatus.mockRejectedValueOnce(new Error('Network error'));
      api.getPaymentSummary.mockRejectedValueOnce(new Error('Network error'));
      api.getStudents.mockRejectedValueOnce(new Error('Network error'));

      api.getSyncStatus.mockResolvedValueOnce({ data: { lastSyncAt: null } });
      api.getPaymentSummary.mockResolvedValueOnce({ data: { totalPaid: 0 } });
      api.getStudents.mockResolvedValueOnce({
        data: { students: [], pages: 1, total: 0 },
      });

      render(<Dashboard />);

      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /retry/i })).toBeInTheDocument();
      });

      const retryButton = screen.getByRole('button', { name: /retry/i });
      fireEvent.click(retryButton);

      await waitFor(() => {
        expect(api.getPaymentSummary).toHaveBeenCalledTimes(2);
      });
    });

    it('should display error timestamp in error banner', async () => {
      api.getSyncStatus.mockRejectedValue(new Error('Network error'));
      api.getPaymentSummary.mockRejectedValue(new Error('Network error'));
      api.getStudents.mockRejectedValue(new Error('Network error'));

      render(<Dashboard />);

      await waitFor(() => {
        const errorBanner = screen.queryByText(/Could not load dashboard/i);
        expect(errorBanner).toBeInTheDocument();
        // Verify timestamp is present (ISO format or relative time)
        expect(errorBanner.parentElement).toHaveTextContent(/ago|:|\d{2}/);
      });
    });

    it('should announce error to screen readers via aria-live', async () => {
      api.getSyncStatus.mockRejectedValue(new Error('Network error'));
      api.getPaymentSummary.mockRejectedValue(new Error('Network error'));
      api.getStudents.mockRejectedValue(new Error('Network error'));

      render(<Dashboard />);

      await waitFor(() => {
        const errorBanner = screen.queryByText(/Could not load dashboard/i);
        const ariaLiveElement = errorBanner?.closest('[aria-live]');
        expect(ariaLiveElement).toHaveAttribute('aria-live', 'assertive');
      });
    });
  });

  describe('Partial data handling', () => {
    it('should show partial content when students load but payments fail', async () => {
      api.getSyncStatus.mockResolvedValue({ data: { lastSyncAt: null } });
      api.getPaymentSummary.mockRejectedValue(new Error('Network error'));
      api.getStudents.mockResolvedValue({
        data: {
          students: [
            { studentId: 'STU001', name: 'Alice', class: '5A', feePaid: false },
          ],
          pages: 1,
          total: 1,
        },
      });

      render(<Dashboard />);

      await waitFor(() => {
        expect(screen.queryByText('Alice')).toBeInTheDocument();
      });

      // Should show warning about payment summary
      expect(screen.queryByText(/Could not load payment summary/i)).toBeInTheDocument();
    });

    it('should show partial content when payments load but students fail', async () => {
      api.getSyncStatus.mockResolvedValue({ data: { lastSyncAt: null } });
      api.getPaymentSummary.mockResolvedValue({
        data: { totalPaid: 500, totalStudents: 10 },
      });
      api.getStudents.mockRejectedValue(new Error('Network error'));

      render(<Dashboard />);

      await waitFor(() => {
        expect(screen.queryByText(/500/)).toBeInTheDocument();
      });

      // Should show warning about student list
      expect(screen.queryByText(/Could not load student list/i)).toBeInTheDocument();
    });

    it('should display warning banner for partial data', async () => {
      api.getSyncStatus.mockResolvedValue({ data: { lastSyncAt: null } });
      api.getPaymentSummary.mockRejectedValue(new Error('Network error'));
      api.getStudents.mockResolvedValue({
        data: {
          students: [
            { studentId: 'STU001', name: 'Alice', class: '5A', feePaid: false },
          ],
          pages: 1,
          total: 1,
        },
      });

      render(<Dashboard />);

      await waitFor(() => {
        const warningBanner = screen.queryByText(/Could not load payment summary/i);
        expect(warningBanner).toBeInTheDocument();
      });
    });
  });

  describe('Error recovery', () => {
    it('should clear error state after successful retry', async () => {
      api.getSyncStatus.mockRejectedValueOnce(new Error('Network error'));
      api.getPaymentSummary.mockRejectedValueOnce(new Error('Network error'));
      api.getStudents.mockRejectedValueOnce(new Error('Network error'));

      api.getSyncStatus.mockResolvedValueOnce({ data: { lastSyncAt: null } });
      api.getPaymentSummary.mockResolvedValueOnce({ data: { totalPaid: 0 } });
      api.getStudents.mockResolvedValueOnce({
        data: { students: [], pages: 1, total: 0 },
      });

      const { rerender } = render(<Dashboard />);

      await waitFor(() => {
        expect(screen.queryByText(/Could not load dashboard/i)).toBeInTheDocument();
      });

      const retryButton = screen.getByRole('button', { name: /retry/i });
      fireEvent.click(retryButton);

      await waitFor(() => {
        expect(screen.queryByText(/Could not load dashboard/i)).not.toBeInTheDocument();
      });
    });

    it('should not show blank page on error', async () => {
      api.getSyncStatus.mockRejectedValue(new Error('Network error'));
      api.getPaymentSummary.mockRejectedValue(new Error('Network error'));
      api.getStudents.mockRejectedValue(new Error('Network error'));

      const { container } = render(<Dashboard />);

      await waitFor(() => {
        // Verify error banner is rendered, not a blank page
        expect(screen.queryByText(/Could not load dashboard/i)).toBeInTheDocument();
        // Verify the container is not empty
        expect(container.innerHTML).not.toBe('');
      });
    });
  });

  describe('Unit test for error banner component', () => {
    it('should render ErrorBanner component with correct props', async () => {
      api.getSyncStatus.mockRejectedValue(new Error('Network error'));
      api.getPaymentSummary.mockRejectedValue(new Error('Network error'));
      api.getStudents.mockRejectedValue(new Error('Network error'));

      render(<Dashboard />);

      await waitFor(() => {
        const errorBanner = screen.queryByText(/Could not load dashboard/i);
        expect(errorBanner).toBeInTheDocument();
      });
    });
  });
});
