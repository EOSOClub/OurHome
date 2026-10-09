'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { Loader2, Smile } from 'lucide-react';
import type { ProfileOverview } from '@/server/services/profileService';
import {
  BIO_MAX,
  PRONOUNS_MAX,
  PROFILE_COLORS,
  PROFILE_COLOR_KEYS,
  isBirthday,
  type ProfileColor,
} from '@/lib/profile';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ProfileAvatar } from '@/components/profile/profile-avatar';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';

// A few quick picks; any single emoji can be typed instead.
const EMOJI_PICKS = ['😀', '😎', '🦊', '🐱', '🐶', '🦄', '🌻', '🌈', '⚽', '🎮', '🎸', '📚', '🍕', '🚀', '⭐', '🏡'];

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** The user's own "about me" fields; everyone in the household sees them. */
export function AboutMeCard({ overview }: { overview: ProfileOverview }) {
  const router = useRouter();
  const p = overview.profile;
  const [emoji, setEmoji] = useState(p.avatarEmoji ?? '');
  const [color, setColor] = useState<ProfileColor | null>(p.profileColor);
  const [pronouns, setPronouns] = useState(p.pronouns ?? '');
  const [bio, setBio] = useState(p.bio ?? '');
  const [month, setMonth] = useState(p.birthday?.slice(0, 2) ?? '');
  const [day, setDay] = useState(p.birthday ? String(Number(p.birthday.slice(3))) : '');

  const birthday = month && day ? `${month}-${day.padStart(2, '0')}` : '';
  const birthdayInvalid = (!!month !== !!day) || (!!birthday && !isBirthday(birthday));
  const dirty =
    emoji.trim() !== (p.avatarEmoji ?? '') ||
    color !== p.profileColor ||
    pronouns.trim() !== (p.pronouns ?? '') ||
    bio.trim() !== (p.bio ?? '') ||
    birthday !== (p.birthday ?? '');

  const save = useMutation({
    mutationFn: () =>
      apiFetch('/api/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          avatarEmoji: emoji.trim() || null,
          profileColor: color,
          pronouns: pronouns.trim() || null,
          bio: bio.trim() || null,
          birthday: birthday || null,
        }),
      }),
    onSuccess: () => {
      toast.success('About me saved');
      router.refresh();
    },
    // Errors (e.g. "Pick a single emoji.") surface via the global toast.
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smile className="size-4" /> About me
        </CardTitle>
        <CardDescription>
          Make your profile yours. Everyone in the household can see this.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty && !birthdayInvalid && !save.isPending) save.mutate();
          }}
          className="space-y-4"
        >
          <div className="flex items-center gap-3">
            <ProfileAvatar name={overview.name} emoji={emoji.trim() || null} color={color} size="lg" />
            <div className="min-w-0">
              <p className="truncate font-medium">{overview.name}</p>
              {pronouns.trim() ? (
                <p className="text-sm text-muted-foreground">{pronouns.trim()}</p>
              ) : null}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="about-emoji">Avatar emoji</Label>
            <div className="flex flex-wrap items-center gap-1.5">
              {EMOJI_PICKS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => setEmoji(e)}
                  aria-pressed={emoji === e}
                  className={cn(
                    'size-9 rounded-md border text-lg transition-colors',
                    emoji === e ? 'border-primary bg-primary/10' : 'border-input hover:bg-accent',
                  )}
                >
                  {e}
                </button>
              ))}
              <Input
                id="about-emoji"
                value={emoji}
                onChange={(e) => setEmoji(e.target.value)}
                placeholder="or type one"
                className="h-9 w-28"
                maxLength={16}
              />
              {emoji ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setEmoji('')}>
                  Use initials
                </Button>
              ) : null}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Colour</Label>
            <div className="flex flex-wrap gap-2">
              {PROFILE_COLOR_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  title={key}
                  aria-label={key}
                  aria-pressed={color === key}
                  onClick={() => setColor(color === key ? null : key)}
                  className={cn(
                    'size-8 rounded-full border-2 transition-transform',
                    color === key ? 'scale-110 border-foreground' : 'border-transparent',
                  )}
                  style={{ backgroundColor: PROFILE_COLORS[key] }}
                />
              ))}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="about-pronouns">Pronouns</Label>
              <Input
                id="about-pronouns"
                value={pronouns}
                maxLength={PRONOUNS_MAX}
                onChange={(e) => setPronouns(e.target.value)}
                placeholder="optional"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="about-month">Birthday</Label>
              <div className="flex gap-2">
                <Select
                  id="about-month"
                  value={month}
                  onChange={(e) => setMonth(e.target.value)}
                  aria-label="Birthday month"
                >
                  <option value="">Month</option>
                  {MONTHS.map((m, i) => (
                    <option key={m} value={String(i + 1).padStart(2, '0')}>
                      {m}
                    </option>
                  ))}
                </Select>
                <Input
                  type="number"
                  min={1}
                  max={31}
                  value={day}
                  onChange={(e) => setDay(e.target.value)}
                  placeholder="Day"
                  aria-label="Birthday day"
                  className="w-20"
                />
              </div>
              {birthdayInvalid ? (
                <p className="text-xs text-destructive">Pick a month and a real day (or neither).</p>
              ) : (
                <p className="text-xs text-muted-foreground">Month and day only, no year.</p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="about-bio">About me</Label>
            <Textarea
              id="about-bio"
              value={bio}
              maxLength={BIO_MAX}
              onChange={(e) => setBio(e.target.value)}
              placeholder="Favourite foods, hobbies, what you're up to…"
            />
            <p className="text-right text-xs text-muted-foreground">
              {bio.length}/{BIO_MAX}
            </p>
          </div>

          <Button type="submit" disabled={!dirty || birthdayInvalid || save.isPending}>
            {save.isPending ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
