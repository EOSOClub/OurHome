'use client';

import { useEffect, useRef, useState } from 'react';
import Script from 'next/script';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

// Minimal typing for the Turnstile global injected by the Cloudflare script.
interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback?: (token: string) => void;
      'error-callback'?: () => void;
      'expired-callback'?: () => void;
      theme?: 'auto' | 'light' | 'dark';
    },
  ) => string;
  reset: (id?: string) => void;
  remove: (id?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export function ContactDialog({
  siteKey,
  nonce,
}: {
  siteKey?: string;
  nonce?: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [description, setDescription] = useState('');
  const [company, setCompany] = useState(''); // honeypot
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [token, setToken] = useState('');
  const [scriptReady, setScriptReady] = useState(false);
  const [scriptRequested, setScriptRequested] = useState(false);

  const openedAt = useRef(0);
  const widgetContainer = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | undefined>(undefined);

  function handleOpen() {
    setName('');
    setEmail('');
    setDescription('');
    setCompany('');
    setError(null);
    setSent(false);
    setToken('');
    openedAt.current = Date.now();
    if (siteKey) setScriptRequested(true);
    setOpen(true);
  }

  function handleClose() {
    setOpen(false);
  }

  // Render (and tear down) the Turnstile widget while the dialog is open.
  useEffect(() => {
    if (!open || !siteKey || !scriptReady) return;
    const turnstile = window.turnstile;
    const container = widgetContainer.current;
    if (!turnstile || !container || widgetId.current) return;
    widgetId.current = turnstile.render(container, {
      sitekey: siteKey,
      callback: (t) => setToken(t),
      'error-callback': () => setToken(''),
      'expired-callback': () => setToken(''),
      theme: 'auto',
    });
    return () => {
      if (widgetId.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetId.current);
        } catch {
          // widget already gone
        }
        widgetId.current = undefined;
      }
    };
  }, [open, siteKey, scriptReady]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (siteKey && !token) {
      setError('Please complete the verification.');
      return;
    }

    setLoading(true);
    try {
      await apiFetch<{ delivered: boolean }>('/api/contact', {
        method: 'POST',
        body: JSON.stringify({
          name,
          email,
          description,
          company,
          elapsedMs: Date.now() - openedAt.current,
          turnstileToken: token,
        }),
      });
      setSent(true);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Something went wrong. Please try again.',
      );
      // Let the visitor retry with a fresh challenge.
      if (widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current);
      setToken('');
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <p className="text-center text-sm text-muted-foreground">
        Have a question?{' '}
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 text-sm"
          onClick={handleOpen}
        >
          Contact us
        </Button>
      </p>

      {scriptRequested && siteKey ? (
        <Script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
          strategy="afterInteractive"
          nonce={nonce}
          onLoad={() => setScriptReady(true)}
          onReady={() => setScriptReady(true)}
        />
      ) : null}

      <Dialog
        open={open}
        onClose={handleClose}
        title="Contact us"
        description="Send us a message and we'll be in touch."
      >
        {sent ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <CheckCircle2 className="size-10 text-primary" />
            <p className="font-medium">Thanks — we&apos;ll be in touch.</p>
            <p className="text-sm text-muted-foreground">
              A confirmation has been sent to your email.
            </p>
            <Button type="button" onClick={handleClose} className="mt-2">
              Close
            </Button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="contact-name">Name</Label>
              <Input
                id="contact-name"
                type="text"
                autoComplete="name"
                required
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="contact-email">Email</Label>
              <Input
                id="contact-email"
                type="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                required
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="contact-description">Description</Label>
              <Textarea
                id="contact-description"
                required
                minLength={10}
                maxLength={5000}
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="How can we help?"
              />
            </div>

            {/* Honeypot: hidden from humans; bots that fill it are dropped. */}
            <div
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: '-9999px',
                width: 1,
                height: 1,
                overflow: 'hidden',
              }}
            >
              <label htmlFor="contact-company">Company</label>
              <input
                id="contact-company"
                type="text"
                tabIndex={-1}
                autoComplete="off"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
              />
            </div>

            {siteKey ? <div ref={widgetContainer} className="min-h-[65px]" /> : null}

            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? <Loader2 className="animate-spin" /> : null}
              Send message
            </Button>
          </form>
        )}
      </Dialog>
    </>
  );
}
