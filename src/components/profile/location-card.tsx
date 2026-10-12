'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, MapPin } from 'lucide-react';
import { isSharing, type LocationConsent } from '@/lib/location';
import { canChangeOwnSharing } from '@/lib/permissions';
import { apiFetch } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/toast';

const CONSENT_KEY = ['location-consent'];

/**
 * Profile → Location: the member's own yes or no to sharing where they are.
 * Off until they turn it on. (The switch for short live checks comes with
 * that feature.)
 */
export function LocationCard({ initial }: { initial: LocationConsent }) {
  const queryClient = useQueryClient();
  const { data: consent = initial } = useQuery({
    queryKey: CONSENT_KEY,
    queryFn: () => apiFetch<LocationConsent>('/api/location/consent'),
    initialData: initial,
  });

  const update = useMutation({
    mutationFn: (sharing: 'off' | 'on') =>
      apiFetch<LocationConsent>('/api/location/consent', { method: 'PATCH', body: JSON.stringify({ sharing }) }),
    onSuccess: (next) => {
      queryClient.setQueryData(CONSENT_KEY, next);
      toast.success(isSharing(next.sharing) ? 'Location sharing on' : 'Location sharing off');
    },
  });

  const sharing = isSharing(consent.sharing);
  const locked = !canChangeOwnSharing(consent.sharing);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MapPin className="size-4" /> Location
        </CardTitle>
        <CardDescription>Off until you turn it on. You can change it any time.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 shrink-0 rounded border-input"
            checked={sharing}
            disabled={locked || update.isPending}
            onChange={(e) => update.mutate(e.target.checked ? 'on' : 'off')}
          />
          <span className="space-y-1">
            <span className="flex items-center gap-2 font-medium">
              Share my location with the household
              {update.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            </span>
            <span className="block text-muted-foreground">
              With the Android app, your phone tells the household when you get to or leave a map place (home, a
              store), and where you were at that moment. Only that last spot is kept, never a history. Store
              reminders need it too.
            </span>
            {locked ? <span className="block text-muted-foreground">Sharing is required for you.</span> : null}
          </span>
        </label>
      </CardContent>
    </Card>
  );
}
