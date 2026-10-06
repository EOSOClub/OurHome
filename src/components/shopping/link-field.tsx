'use client';

import { useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import type { LinkPreviewDTO } from '@/lib/types';
import { apiFetch, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Product-link field shared by the add and edit forms: a URL input plus a
 * best-effort "Fetch details" action that pulls Open Graph title/image/price
 * from the page. The fetched preview is handed back via `onPreview`; the parent
 * decides what to apply (we never clobber fields the user already filled).
 */
export function LinkField({
  id,
  url,
  imageUrl,
  onUrlChange,
  onPreview,
}: {
  id: string;
  url: string;
  imageUrl: string | null;
  onUrlChange: (value: string) => void;
  onPreview: (preview: LinkPreviewDTO) => void;
}) {
  const [fetching, setFetching] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function fetchPreview() {
    const trimmed = url.trim();
    if (!trimmed) return;
    setFetching(true);
    setNote(null);
    try {
      const preview = await apiFetch<LinkPreviewDTO>(
        '/api/shopping/items/preview',
        { method: 'POST', body: JSON.stringify({ url: trimmed }) },
      );
      onPreview(preview);
      if (!preview.title && !preview.imageUrl && preview.price == null) {
        setNote("Couldn't read that link — fill the details in manually.");
      }
    } catch (err) {
      setNote(
        err instanceof ApiError ? err.message : 'Failed to fetch link details.',
      );
    } finally {
      setFetching(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Link</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => {
            onUrlChange(e.target.value);
            if (note) setNote(null);
          }}
          placeholder="Paste an Amazon (or other) product link…"
        />
        <Button
          type="button"
          variant="outline"
          className="shrink-0"
          onClick={fetchPreview}
          disabled={fetching || !url.trim()}
        >
          {fetching ? <Loader2 className="animate-spin" /> : <Sparkles />}
          Fetch details
        </Button>
      </div>
      {imageUrl ? (
        <div className="flex items-center gap-2 pt-1">
          {/* Remote OG image from an arbitrary host — plain <img> avoids having
              to allowlist every retailer's CDN in next.config. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrl}
            alt=""
            className="size-12 shrink-0 rounded border border-border bg-white object-contain"
          />
          <span className="text-xs text-muted-foreground">
            Preview image attached
          </span>
        </div>
      ) : null}
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}
