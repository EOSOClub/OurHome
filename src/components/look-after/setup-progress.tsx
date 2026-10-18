import type { ReactNode } from 'react';
import { CheckCircle2, Circle } from 'lucide-react';
import type { LookAfterDTO } from '@/lib/types';
import { PHONE_SETUP_STEP_LABELS } from '@/lib/phoneHealth';
import { RelativeTime } from '@/components/household-zone';

// How far a supervised child's phone has got with Set up this phone, from its
// check-ins: their own password, the app signed in, then each step their
// supervisors require, in the app's order. Their phone checks in after each
// step, so this fills in as they go. Shown open on Set up a child's last step,
// and folded under each name on People you look after.

type Person = LookAfterDTO['people'][number];

/** Every step done, from the password to the last required step. */
export function setupComplete(person: Person): boolean {
  return person.setup.passwordChosen && person.phone !== null && person.setup.steps.every((s) => s.done === true);
}

function Row({ done, label, detail }: { done: boolean; label: string; detail?: ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {done ? (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--color-success)]" aria-label="Done" />
      ) : (
        <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Not done yet" />
      )}
      <span className="min-w-0">
        <span className={done ? undefined : 'text-muted-foreground'}>{label}</span>
        {detail ? <span className="block text-xs text-muted-foreground">{detail}</span> : null}
      </span>
    </li>
  );
}

/** The list itself. */
export function SetupSteps({ person }: { person: Person }) {
  const { phone, setup } = person;
  return (
    <ul className="space-y-2">
      <Row
        done={setup.passwordChosen}
        label="Chose their own password"
        detail={setup.passwordChosen ? undefined : 'They do this the first time they sign in.'}
      />
      <Row
        done={phone !== null}
        label="Signed in to the OurHome app"
        detail={
          phone ? (
            <>
              {phone.deviceName ? `${phone.deviceName}, ` : ''}checked in <RelativeTime date={phone.lastSeenAt} />
            </>
          ) : (
            'Waiting for their phone to check in.'
          )
        }
      />
      {setup.steps.map(({ step, done }) => (
        <Row
          key={step}
          done={done === true}
          label={PHONE_SETUP_STEP_LABELS[step]}
          detail={
            done === null && phone
              ? 'Their app is too old to say. Update OurHome on their phone.'
              : step === 'preventUninstall' && done !== true
                ? 'A parent does this one: it needs the parent PIN.'
                : undefined
          }
        />
      ))}
    </ul>
  );
}

/** Folded: "Set up this phone: 3 of 6 done", opening to the list. */
export function SetupProgress({ person }: { person: Person }) {
  const { steps } = person.setup;
  const done = steps.filter((s) => s.done === true).length;
  const summary = setupComplete(person)
    ? `Set up this phone: all ${steps.length} done`
    : person.phone
      ? `Set up this phone: ${done} of ${steps.length} done`
      : 'Set up this phone: not started';
  return (
    <details className="group text-sm">
      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">{summary}</summary>
      <div className="mt-2 pl-1">
        <SetupSteps person={person} />
      </div>
    </details>
  );
}
