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
import { AddOnCatalogItem, Booking, PaymentMethod, SpaceId } from "./booking-data";

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
    input: CreateHoldClientInput
  ) => Promise<Booking & { _stripe?: StripeIntentResult }>;
  confirmPaymentAsync: (id: string) => Promise<ConfirmResult>;
  releaseHoldAsync: (id: string) => Promise<void>;
  rejectBookingAsync: (id: string) => Promise<void>;
  createHoldPending: boolean;
  mutationPendingId: string | null;
};

// Input shape sent to POST /api/bookings (server resolves add-on line totals).
export type CreateHoldClientInput = {
  spaceId: Booking["spaceId"];
  activityId: Booking["activityId"];
  start: string;
  end: string;
  guest: Booking["guest"];
  guestCount: number;
  alcohol: boolean;
  addons: { addOnId: string; quantity: number }[];
  paymentMethod: PaymentMethod;
};

export type StripeIntentResult = {
  ok: boolean;
  mode: "live" | "simulation";
  clientSecret?: string;
  publishableKey?: string;
  paymentIntentId?: string;
  amount?: number;
  baseTotal?: number;
  cardFeeAmount?: number;
  customerTotal?: number;
  reason?: string;
  error?: string;
};

export type StripeConfig = {
  mode: "live" | "simulation";
  publishableKey: string | null;
  feePercent: number;
  feeFixed: number;
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
    mutationFn: async (input: CreateHoldClientInput) => {
      const res = await apiRequest("POST", "/api/bookings", input);
      // For card bookings the server returns the synthetic booking with the
      // Stripe PaymentIntent details attached as `_stripe`. Zelle bookings
      // return the real booking row with no `_stripe` field.
      return (await res.json()) as Booking & { _stripe?: StripeIntentResult };
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

  const rejectMutation = useMutation({
    mutationFn: async (id: string) => {
      setMutationPendingId(id);
      await apiRequest("POST", `/api/bookings/${id}/reject`, undefined, {
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
      rejectBookingAsync: async (id) => {
        await rejectMutation.mutateAsync(id);
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
      rejectMutation,
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

// ----- Add-on catalog hooks -----

const PUBLIC_ADDONS_KEY = ["/api/addons"] as const;
const ADMIN_ADDONS_KEY = ["/api/admin/addons"] as const;

export function usePublicAddOns() {
  return useQuery<AddOnCatalogItem[]>({
    queryKey: PUBLIC_ADDONS_KEY,
    staleTime: 60_000,
  });
}

export function useAdminAddOns() {
  const { adminPin } = useAdmin();
  return useQuery<AddOnCatalogItem[]>({
    queryKey: ADMIN_ADDONS_KEY,
    enabled: !!adminPin,
    staleTime: 15_000,
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/admin/addons", undefined, {
        headers: { "x-admin-pin": adminPin ?? "" },
      });
      return (await res.json()) as AddOnCatalogItem[];
    },
  });
}

export type CreateAddOnFields = {
  name: string;
  description?: string | null;
  price: number;
  priceType: "per_item" | "flat";
  imageUrl?: string | null;
  quantityAvailable?: number | null;
  active?: boolean;
};

export function useAddOnMutations() {
  const { adminPin } = useAdmin();
  const headers = { "x-admin-pin": adminPin ?? "" };

  const create = useMutation({
    mutationFn: async (input: CreateAddOnFields) => {
      const res = await apiRequest("POST", "/api/admin/addons", input, { headers });
      return (await res.json()) as AddOnCatalogItem;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ADMIN_ADDONS_KEY });
      queryClient.invalidateQueries({ queryKey: PUBLIC_ADDONS_KEY });
    },
  });

  const update = useMutation({
    mutationFn: async (args: { id: string; patch: Partial<CreateAddOnFields> }) => {
      const res = await apiRequest(
        "PATCH",
        `/api/admin/addons/${args.id}`,
        args.patch,
        { headers }
      );
      return (await res.json()) as AddOnCatalogItem;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ADMIN_ADDONS_KEY });
      queryClient.invalidateQueries({ queryKey: PUBLIC_ADDONS_KEY });
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/admin/addons/${id}`, undefined, { headers });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ADMIN_ADDONS_KEY });
      queryClient.invalidateQueries({ queryKey: PUBLIC_ADDONS_KEY });
    },
  });

  return { create, update, remove };
}

// ----- Stripe (card payments) -----

const STRIPE_CONFIG_KEY = ["/api/stripe/config"] as const;

export function useStripeConfig() {
  return useQuery<StripeConfig>({
    queryKey: STRIPE_CONFIG_KEY,
    // Stripe config is effectively static for a deploy; cache aggressively.
    staleTime: 5 * 60_000,
  });
}

export async function fetchStripeIntentForBooking(
  bookingId: string
): Promise<StripeIntentResult> {
  const res = await apiRequest(
    "POST",
    `/api/bookings/${bookingId}/stripe/intent`,
    {}
  );
  return (await res.json()) as StripeIntentResult;
}

// ----- Peerspace email-reply agent (admin Inbox) -----

export type AgentMessage = {
  id: string;
  conversationId: string;
  direction: "inbound" | "outbound";
  fromAddress?: string | null;
  toAddress?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  createdAt: number;
};

export type AgentDraft = {
  id: string;
  conversationId: string;
  inboundMessageId: string;
  proposedSubject?: string | null;
  proposedBodyText?: string | null;
  editedBody?: string | null;
  model?: string | null;
  status: "pending" | "approved" | "rejected" | "sent" | "error";
  reviewedAt?: number | null;
  sentAt?: number | null;
  resendId?: string | null;
  error?: string | null;
  createdAt: number;
};

export type AgentConversation = {
  id: string;
  threadToken: string;
  peerspaceReplyTo?: string | null;
  guestName?: string | null;
  guestEmail?: string | null;
  bookingId?: string | null;
  subject?: string | null;
  status: "open" | "closed";
  createdAt: number;
  updatedAt: number;
  messages: AgentMessage[];
  drafts: AgentDraft[];
};

const AGENT_CONVERSATIONS_KEY = ["/api/admin/agent/conversations"] as const;

export function useAgentConversations() {
  const { adminPin } = useAdmin();
  return useQuery<AgentConversation[]>({
    queryKey: AGENT_CONVERSATIONS_KEY,
    enabled: !!adminPin,
    staleTime: 10_000,
    // Light polling so newly-drafted replies show up without a manual refresh.
    refetchInterval: adminPin ? 30_000 : false,
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        "/api/admin/agent/conversations",
        undefined,
        { headers: { "x-admin-pin": adminPin ?? "" } }
      );
      return (await res.json()) as AgentConversation[];
    },
  });
}

export function useAgentDraftActions() {
  const { adminPin } = useAdmin();
  const headers = { "x-admin-pin": adminPin ?? "" };
  return useMutation({
    mutationFn: async (args: {
      draftId: string;
      action: "approve" | "reject" | "edit";
      editedBody?: string;
    }) => {
      const res = await apiRequest(
        "POST",
        `/api/admin/agent/drafts/${args.draftId}/action`,
        { action: args.action, editedBody: args.editedBody },
        { headers }
      );
      return (await res.json()) as { ok: boolean; simulated?: boolean };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: AGENT_CONVERSATIONS_KEY });
    },
  });
}
