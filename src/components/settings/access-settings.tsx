'use client';

import { useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, ShieldCheck } from 'lucide-react';
import type { AccessSettingsDTO } from '@/lib/types';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';

// "Decide later" hides the prompt for this browser session only.
const LATER_KEY = 'ourhome.access-prompt-later';

const OPTIONS = [
  {
    allowHttp: true,
    title: 'Home network and HTTPS',
    body: 'Devices on your network can use the server’s local address (http://…). Traffic on your Wi-Fi isn’t encrypted, including sign-in.',
  },
  {
    allowHttp: false,
    title: 'HTTPS only',
    body: 'Sign-in only works at your https:// address. http://localhost on the server itself still works, as a way back in. Everyone else on the server, in every household, is signed out once.',
  },
] as const;

/** The two choices plus warnings about what saving would do right now. */
function AccessChoice({
  settings,
  value,
  onChange,
}: {
  settings: AccessSettingsDTO;
  value: boolean;
  onChange: (allowHttp: boolean) => void;
}) {
  return (
    <div className="space-y-3" role="radiogroup" aria-label="How the site can be reached">
      {OPTIONS.map((o) => (
        <label
          key={String(o.allowHttp)}
          className={cn(
            'flex cursor-pointer gap-3 rounded-md border p-3 text-sm transition-colors',
            value === o.allowHttp ? 'border-primary bg-primary/5' : 'border-border',
          )}
        >
          <input
            type="radio"
            name="access"
            className="mt-1"
            checked={value === o.allowHttp}
            onChange={() => onChange(o.allowHttp)}
          />
          <span>
            <span className="block font-medium">{o.title}</span>
            <span className="text-muted-foreground">{o.body}</span>
          </span>
        </label>
      ))}
      {!value && !settings.publicUrl ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          No https:// address is set up yet (<code>better_auth.url</code> in settings.yml), so other
          devices won’t be able to sign in at all. Only http://localhost on the
          server will work.
        </p>
      ) : null}
      {!value && settings.connection === 'http' ? (
        <p className="rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-3 text-sm">
          You’re connected over plain HTTP, so you’ll be signed out here.
          {settings.publicUrl ? ` Continue at ${settings.publicUrl}.` : ''}
        </p>
      ) : null}
    </div>
  );
}

/** Save, then leave the page if this connection just got cut off. */
function useSaveAccess(onSaved: (next: AccessSettingsDTO) => void) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  async function save(settings: AccessSettingsDTO, allowHttp: boolean) {
    setSaving(true);
    try {
      const next = await apiFetch<AccessSettingsDTO>('/api/household/access', {
        method: 'PUT',
        body: JSON.stringify({ allowHttp }),
      });
      onSaved(next);
      if (!allowHttp && settings.connection === 'http') {
        window.location.href = settings.publicUrl ?? '/login';
        return;
      }
      toast.success(allowHttp ? 'Home-network access is on' : 'Sign-in is now HTTPS only');
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }
  return { save, saving };
}

/** One-time prompt for the server admin after setup, until they choose. */
export function AccessPrompt({ settings }: { settings: AccessSettingsDTO }) {
  // Read after hydration: the server renders it closed, the browser decides.
  const postponed = useSyncExternalStore(
    () => () => {},
    () => {
      try {
        return sessionStorage.getItem(LATER_KEY) === '1';
      } catch {
        return false;
      }
    },
    () => true,
  );
  const [closed, setClosed] = useState(false);
  const [allowHttp, setAllowHttp] = useState(settings.allowHttp);
  const { save, saving } = useSaveAccess(() => setClosed(true));

  function later() {
    try {
      sessionStorage.setItem(LATER_KEY, '1');
    } catch {
      // Private mode: it just shows again on the next page load.
    }
    setClosed(true);
  }
  const open = !postponed && !closed;

  return (
    <Dialog
      open={open}
      onClose={later}
      title="Secure your home"
      description="How will people reach the site? You can change this later under Settings → Security."
      footer={
        <>
          <Button variant="ghost" onClick={later} disabled={saving}>
            Decide later
          </Button>
          <Button onClick={() => save(settings, allowHttp)} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
        </>
      }
    >
      <AccessChoice settings={settings} value={allowHttp} onChange={setAllowHttp} />
    </Dialog>
  );
}

/** Settings → Security: the same choice, any time. */
export function AccessCard({ initialSettings }: { initialSettings: AccessSettingsDTO }) {
  const [settings, setSettings] = useState(initialSettings);
  const [allowHttp, setAllowHttp] = useState(initialSettings.allowHttp);
  const { save, saving } = useSaveAccess(setSettings);
  const changed = allowHttp !== settings.allowHttp;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4" /> Security
        </CardTitle>
        <CardDescription>
          Where people can sign in from. Home Assistant and other token-based
          connections aren’t affected.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <AccessChoice settings={settings} value={allowHttp} onChange={setAllowHttp} />
        <div className="flex justify-end">
          <Button onClick={() => save(settings, allowHttp)} disabled={saving || !changed}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
