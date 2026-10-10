import { Cake, Users } from 'lucide-react';
import type { HouseholdProfile } from '@/server/services/profileService';
import { formatBirthday } from '@/lib/profile';
import { USER_ROLE_LABELS, type UserRole } from '@/lib/enums';
import { ProfileAvatar } from '@/components/profile/profile-avatar';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

/** Everyone's about-me, read-only: who's who in the household. */
export function HouseholdCard({ members, userId }: { members: HouseholdProfile[]; userId: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="size-4" /> Household
        </CardTitle>
        <CardDescription>What everyone has shared about themselves.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {members.map((m) => {
            const birthday = formatBirthday(m.birthday);
            return (
              <li key={m.id} className="flex gap-3 px-3 py-3">
                <ProfileAvatar name={m.name} emoji={m.avatarEmoji} color={m.profileColor} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {m.name}
                    {m.id === userId ? <span className="text-muted-foreground"> (you)</span> : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {USER_ROLE_LABELS[m.role as UserRole] ?? m.role}
                  </p>
                  {m.bio ? <p className="mt-1 whitespace-pre-line text-sm">{m.bio}</p> : null}
                  {birthday ? (
                    <p className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Cake className="size-3" /> {birthday}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
