import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "./queryClient";
import { Booking, SpaceId } from "./booking-data";

// ----- Booking data context (server-backed) -----

export type ConfirmEmailResult = {
  ok: boolean;
  mode: "live" | "simulation";
  reason?: string;
  providerId?: string | null;
  status?: number;
  error?: string;
};

export type ConfirmResult = Booking & { email?: ConfirmEmailResult };

type BookingCtx = {
  bookings: Booking[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  now: Date; // ticks every 30s for hold expiry display
  createHoldAsync: (
    input: Omit<Booking, "id" | "status" | "createdAt" | "holdExpiresAt" | "source">
  ) => Promise<Booking>;
  confirmPaymentAsync: (id: string) => Promise<ConfirmResult>;
  releaseHoldAsync: (id: string) => Promise<void>;
  createHoldPending: boolean;
  mutationPendingId: string | null;
};

const BookingContext = createContext<BookingCtx | null>(null);

const BOOKINGS_KEY = ["/api/bookings"] as const;

export function BookingProvider({ children }: { children: React.ReactNode }) {
  const [now, setNow] = useState<Date>(new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const query = useQuery<Booking[]>({
    queryKey: BOOKINGS_KEY,
    // Bookings drift over time (holds expire) so don't cache forever.
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const { adminPin } = useAdminPinInternal();

  const [mutationPendingId, setMutationPendingId] = useState<string | null>(null);

  const createHoldMutation = useMutation({
    mutationFn: async (
      input: Omit<Booking, "id" | "status" | "createdAt" | "holdExpiresAt" | "source">
    ) => {
      const res = await apiRequest("POST", "/api/bookings", input);
      return (await res.json()) as Booking;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: BOOKINGS_KEY });
    },
  });

  const confirmMutation = useMutation({
    mutationFn: async (id: string) => {
      setMutationPendingId(id);
      const res = await apiRequest(
        "POST",
        `/api/bookings/${id}/confirm`,
        undefined,
        { headers: { "x-admin-pin": adminPin ?? "" } }
      );
      return (await res.json()) as ConfirmResult;
    },
    onSettled: () => {
      setMutationPendingId(null);
      queryClient.invalidateQueries({ queryKey: BOOKINGS_KEY });
    },
  });

  const releaseMutation = useMutation({
    mutationFn: async (id: string) => {
      setMutationPendingId(id);
      await apiRequest("POST", `/api/bookings/${id}/release`, undefined, {
        headers: { "x-admin-pin": adminPin ?? "" },
      });
    },
    onSettled: () => {
      setMutationPendingId(null);
      queryClient.invalidateQueries({ queryKey: BOOKINGS_KEY });
    },
  });

  const value = useMemo<BookingCtx>(
    () => ({
      bookings: query.data ?? [],
      isLoading: query.isLoading,
      isError: query.isError,
      refetch: () => {
        queryClient.invalidateQueries({ queryKey: BOOKINGS_KEY });
      },
      now,
      createHoldAsync: (input) => createHoldMutation.mutateAsync(input),
      confirmPaymentAsync: (id) => confirmMutation.mutateAsync(id),
      releaseHoldAsync: async (id) => {
        await releaseMutation.mutateAsync(id);
      },
      createHoldPending: createHoldMutation.isPending,
      mutationPendingId,
    }),
    [
      query.data,
      query.isLoading,
      query.isError,
      now,
      createHoldMutation,
      confirmMutation,
      releaseMutation,
      mutationPendingId,
    ]
  );

  return <BookingContext.Provider value={value}>{children}</BookingContext.Provider>;
}

export function useBookings() {
  const ctx = useContext(BookingContext);
  if (!ctx) throw new Error("useBookings must be used within BookingProvider");
  return ctx;
}

export function useBookingsForSpace(spaceId: SpaceId) {
  const { bookings } = useBookings();
  return bookings.filter((b) => b.spaceId === spaceId);
}

// ----- Admin PIN context (in-memory only — no localStorage/sessionStorage/cookies) -----

type AdminCtx = {
  adminPin: string | null;
  isUnlocked: boolean;
  unlock: (pin: string) => Promise<boolean>;
  lock: () => void;
};

const AdminContext = createContext<AdminCtx | null>(null);

export function AdminProvider({ children }: { children: React.ReactNode }) {
  const [adminPin, setAdminPin] = useState<string | null>(null);

  const unlock = useCallback(async (pin: string) => {
    try {
      const res = await apiRequest("POST", "/api/admin/verify", { pin });
      const json = (await res.json()) as { ok: boolean };
      if (json.ok) {
        setAdminPin(pin);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  const lock = useCallback(() => setAdminPin(null), []);

  const value = useMemo<AdminCtx>(
    () => ({ adminPin, isUnlocked: !!adminPin, unlock, lock }),
    [adminPin, unlock, lock]
  );

  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>;
}

// Internal hook used by the BookingProvider so it can attach the PIN to admin
// mutations. Must run beneath AdminProvider — see App.tsx.
function useAdminPinInternal() {
  const ctx = useContext(AdminContext);
  return { adminPin: ctx?.adminPin ?? null };
}

export function useAdmin() {
  const ctx = useContext(AdminContext);
  if (!ctx) throw new Error("useAdmin must be used within AdminProvider");
  return ctx;
}
