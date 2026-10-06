'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Inbox, Mail } from 'lucide-react';
import type { ContactMessageDTO } from '@/lib/types';
import { apiFetch } from '@/lib/api';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { EmptyState } from '@/components/empty-state';

const MESSAGES_KEY = ['contact-messages'];

// "email_failed" gets warning styling: the message was stored but never
// forwarded by email, so this card is the only place it surfaces.
const STATUS_BADGES: Record<
  string,
  { label: string; variant: BadgeProps['variant'] }
> = {
  received: { label: 'Received', variant: 'secondary' },
  emailed: { label: 'Emailed', variant: 'success' },
  email_failed: { label: 'Email failed', variant: 'warning' },
};

export function ContactMessagesCard({
  initialMessages,
}: {
  initialMessages: ContactMessageDTO[];
}) {
  const { data: messages = [] } = useQuery({
    queryKey: MESSAGES_KEY,
    queryFn: () => apiFetch<ContactMessageDTO[]>('/api/contact/messages'),
    initialData: initialMessages,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="size-4" /> Contact messages
        </CardTitle>
        <CardDescription>
          Recent public contact-form submissions. Messages marked{' '}
          <span className="font-medium text-[var(--color-warning)]">
            Email failed
          </span>{' '}
          were stored but never forwarded — reply to them from here.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {messages.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="No messages yet"
            description="Submissions from the public contact form will show up here."
          />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {messages.map((message) => (
              <MessageRow key={message.id} message={message} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function MessageRow({ message }: { message: ContactMessageDTO }) {
  const [expanded, setExpanded] = useState(false);
  const badge = STATUS_BADGES[message.status] ?? {
    label: message.status,
    variant: 'secondary' as const,
  };

  return (
    <li className="space-y-1.5 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {message.name}{' '}
            <a
              href={`mailto:${message.email}`}
              className="font-normal text-muted-foreground hover:underline"
            >
              {message.email}
            </a>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={badge.variant}>{badge.label}</Badge>
          <span className="text-xs text-muted-foreground">
            {new Date(message.createdAt).toLocaleString()}
          </span>
        </div>
      </div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="block w-full text-left"
        title={expanded ? 'Collapse message' : 'Expand message'}
      >
        <p
          className={`whitespace-pre-wrap text-sm text-muted-foreground ${
            expanded ? '' : 'line-clamp-2'
          }`}
        >
          {message.description}
        </p>
      </button>
    </li>
  );
}
