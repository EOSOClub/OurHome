'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { BellRing, Loader2 } from 'lucide-react';
import type { RingOverviewDTO } from '@/lib/types';
import { apiFetch, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/toast';

// Ringing a child's phone loudly, even on silent (supervisionService.ringPhone).
// Only shown to adults who supervise someone; the server checks it again.

/** How long the phone rings, and so how long the button rests. */
const RING_MS = 30_000;

export function RingPhoneCard() {
  const { data } = useQuery({
    queryKey: ['ring-overview'],
    queryFn: () => apiFetch<RingOverviewDTO>('/api/supervision/ring'),
  });
  if (!data || data.ringable.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BellRing className="size-4" /> Ring phone
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 pt-0">
        {data.available ? (
          <>
            <p className="text-xs text-muted-foreground">
              Rings loudly for up to 30 seconds, even on silent. They can tap Stop on their phone.
            </p>
            <ul className="space-y-1">
              {data.ringable.map((kid) => (
                <RingRow key={kid.id} kid={kid} />
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Ringing a phone needs instant phone alerts, which this server doesn&apos;t have set up.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function RingRow({ kid }: { kid: { id: string; name: string } }) {
  // Rests while the phone rings, so a second tap can't be refused by the server.
  const [ringingUntil, setRingingUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const ringing = now < ringingUntil;
  useEffect(() => {
    if (!ringing) return;
    const t = setTimeout(() => setNow(Date.now()), ringingUntil - now);
    return () => clearTimeout(t);
  }, [ringing, ringingUntil, now]);

  const ring = useMutation({
    mutationFn: () =>
      apiFetch<{ rung: boolean }>('/api/supervision/ring', {
        method: 'POST',
        body: JSON.stringify({ targetId: kid.id }),
      }),
    onSuccess: () => {
      const at = Date.now();
      setNow(at);
      setRingingUntil(at + RING_MS);
      toast.success(`Ringing ${kid.name}’s phone`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not ring their phone.'),
  });

  return (
    <li className="flex items-center justify-between gap-2 px-2 py-1 text-sm">
      <span className="min-w-0 truncate font-medium">{kid.name}</span>
      <Button size="sm" variant="outline" disabled={ring.isPending || ringing} onClick={() => ring.mutate()}>
        {ring.isPending ? <Loader2 className="animate-spin" /> : <BellRing />}
        {ringing ? 'Ringing' : 'Ring'}
      </Button>
    </li>
  );
}
