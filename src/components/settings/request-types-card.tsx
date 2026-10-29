'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Inbox, Loader2 } from 'lucide-react';
import {
  MEDIA_TYPES,
  MEDIA_TYPE_SECTION_LABELS,
  REQUEST_CATEGORY_LABELS,
  USER_ROLES,
  USER_ROLE_LABELS,
  type MediaType,
  type UserRole,
} from '@/lib/enums';
import {
  REQUEST_MODULE_DESCRIPTIONS,
  REQUEST_MODULE_LIMITS,
  type CommonModuleSettings,
  type DecisionModuleSettings,
  type RequestModuleSettings,
} from '@/lib/requestModules';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CollapsibleCard, SectionCard } from '@/components/ui/collapsible-card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { FieldNote } from '@/components/ui/field-note';
import { useFieldErrors } from '@/lib/use-field-errors';

type Member = { id: string; name: string };

/** Adds or removes `value` from a list. */
function toggle<T>(list: T[], value: T, on: boolean): T[] {
  return on ? (list.includes(value) ? list : [...list, value]) : list.filter((v) => v !== value);
}

function Check({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="size-4 rounded border-input"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

/** Beside a section's title, so a folded section still shows whether it's on, or that it needs fixing before Save. */
function StateBadge({ enabled, problem }: { enabled: boolean; problem: boolean }) {
  if (problem) return <Badge variant="destructive">Needs fixing</Badge>;
  return enabled ? <Badge variant="success">On</Badge> : <Badge variant="secondary">Off</Badge>;
}

/** A list of people to tick, for "chosen people" settings. */
function PeoplePicker({
  members,
  selected,
  onChange,
}: {
  members: Member[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2 pl-1">
      {members.map((m) => (
        <Check
          key={m.id}
          label={m.name}
          checked={selected.includes(m.id)}
          onChange={(on) => onChange(toggle(selected, m.id, on))}
        />
      ))}
    </div>
  );
}

/** Name, note and who may ask: what every request type has. */
function CommonFields<T extends CommonModuleSettings>({
  id,
  defaultLabel,
  value,
  onChange,
}: {
  id: string;
  defaultLabel: string;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-label`}>Name</Label>
          <Input
            id={`${id}-label`}
            value={value.label ?? ''}
            placeholder={defaultLabel}
            maxLength={REQUEST_MODULE_LIMITS.label}
            aria-describedby={`${id}-label-note`}
            onChange={(e) => onChange({ ...value, label: e.target.value })}
          />
          <FieldNote id={`${id}-label-note`} hint="Shown on the Requests page. Leave empty for the usual name." />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-note`}>Note on the form (optional)</Label>
          <Input
            id={`${id}-note`}
            value={value.note ?? ''}
            maxLength={REQUEST_MODULE_LIMITS.note}
            aria-describedby={`${id}-note-note`}
            onChange={(e) => onChange({ ...value, note: e.target.value })}
          />
          <FieldNote id={`${id}-note-note`} hint="Shown when someone picks this type." />
        </div>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Who can ask</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2 pl-1">
          {USER_ROLES.map((role: UserRole) => (
            <Check
              key={role}
              label={USER_ROLE_LABELS[role]}
              checked={value.askRoles.includes(role)}
              onChange={(on) => onChange({ ...value, askRoles: toggle(value.askRoles, role, on) })}
            />
          ))}
        </div>
        <FieldNote id={`${id}-roles-note`} hint="They also need Requests “Add” in Members → Permissions." />
      </fieldset>
    </>
  );
}

/**
 * Purchase or Permission: on, the common fields, and who decides - the
 * requester's supervisors first if ticked, then the Approve switch or chosen
 * people. Declining is always possible.
 */
function DecisionSection({
  id,
  module,
  members,
  value,
  chosen,
  onChange,
  onChosenChange,
}: {
  id: string;
  module: 'purchase' | 'permission';
  members: Member[];
  value: DecisionModuleSettings;
  chosen: boolean;
  onChange: (next: DecisionModuleSettings) => void;
  onChosenChange: (chosen: boolean) => void;
}) {
  const missing = value.enabled && chosen && value.handlerIds.length === 0;
  return (
    <div data-field={module}>
      <SectionCard
        title={REQUEST_CATEGORY_LABELS[module]}
        description={REQUEST_MODULE_DESCRIPTIONS[module]}
        aside={<StateBadge enabled={value.enabled} problem={missing} />}
        foldable
        openWhen={missing}
      >
        <div className="space-y-4">
          <Check label="On" checked={value.enabled} onChange={(on) => onChange({ ...value, enabled: on })} />
          {value.enabled ? (
            <>
              <CommonFields id={id} defaultLabel={REQUEST_CATEGORY_LABELS[module]} value={value} onChange={onChange} />
              <div className="space-y-2">
                <Check
                  label="The asker's supervisors decide, when they have any"
                  checked={value.bySupervisors}
                  onChange={(on) => onChange({ ...value, bySupervisors: on })}
                />
                <FieldNote
                  id={`${id}-supervisors-note`}
                  hint="A child's or teen's supervisors are set on the Members page. Only they decide that child's request; the head and managers don't, unless they're one of them."
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${id}-handlers`}>
                  {value.bySupervisors ? 'Who decides for everyone else' : 'Who decides'}
                </Label>
                <Select
                  id={`${id}-handlers`}
                  value={chosen ? 'chosen' : 'switch'}
                  onChange={(e) => onChosenChange(e.target.value === 'chosen')}
                >
                  <option value="switch">Everyone with Requests “Approve”</option>
                  <option value="chosen">Only the people I pick</option>
                </Select>
                {chosen ? (
                  <PeoplePicker
                    members={members}
                    selected={value.handlerIds}
                    onChange={(ids) => onChange({ ...value, handlerIds: ids })}
                  />
                ) : null}
                <FieldNote
                  id={`${id}-handlers-note`}
                  error={missing ? 'Pick at least one person.' : null}
                  hint={
                    chosen
                      ? 'They can always say no, with a reason.'
                      : 'Set in Members → Permissions. Out of the box: you and Managers. They can always say no, with a reason.'
                  }
                />
              </div>
            </>
          ) : null}
        </div>
      </SectionCard>
    </div>
  );
}

/**
 * Head only: which kinds of request the household can make (Media,
 * Maintenance, Purchase, Permission) and how each one works. Saved as a whole.
 */
export function RequestTypesCard({
  initial,
  members,
}: {
  initial: RequestModuleSettings;
  members: Member[];
}) {
  const queryClient = useQueryClient();
  const [media, setMedia] = useState(initial.media);
  const [maintenance, setMaintenance] = useState(initial.maintenance);
  const [purchase, setPurchase] = useState(initial.purchase);
  const [permission, setPermission] = useState(initial.permission);
  // "Chosen people" is on while the list has anyone in it; an empty list means everyone.
  const [mediaChosen, setMediaChosen] = useState(initial.media.handlerIds.length > 0);
  const [maintenanceChosen, setMaintenanceChosen] = useState(initial.maintenance.assigneeIds.length > 0);
  const [purchaseChosen, setPurchaseChosen] = useState(initial.purchase.handlerIds.length > 0);
  const [permissionChosen, setPermissionChosen] = useState(initial.permission.handlerIds.length > 0);
  const fe = useFieldErrors('rt-card');

  const handlerIds = mediaChosen ? media.handlerIds : [];
  const assigneeIds = maintenanceChosen ? maintenance.assigneeIds : [];
  const askable = maintenanceChosen ? members.filter((m) => maintenance.assigneeIds.includes(m.id)) : members;
  // The default person has to be someone who can be asked.
  const defaultAssigneeId =
    maintenance.defaultAssigneeId && askable.some((m) => m.id === maintenance.defaultAssigneeId)
      ? maintenance.defaultAssigneeId
      : null;
  const missingHandlers = media.enabled && mediaChosen && handlerIds.length === 0;
  const noMediaTypes = media.enabled && media.mediaTypes.length === 0;
  const missingAssignees = maintenance.enabled && maintenanceChosen && assigneeIds.length === 0;
  const missingDeciders =
    (purchase.enabled && purchaseChosen && purchase.handlerIds.length === 0) ||
    (permission.enabled && permissionChosen && permission.handlerIds.length === 0);

  const save = useMutation({
    mutationFn: () =>
      apiFetch<RequestModuleSettings>('/api/requests/modules/settings', {
        method: 'POST',
        body: JSON.stringify({
          // Unticking both kinds is only allowed with Media off: keep what it had then.
          media: { ...media, handlerIds, mediaTypes: media.mediaTypes.length ? media.mediaTypes : initial.media.mediaTypes },
          maintenance: { ...maintenance, assigneeIds, defaultAssigneeId },
          purchase: { ...purchase, handlerIds: purchaseChosen ? purchase.handlerIds : [] },
          permission: { ...permission, handlerIds: permissionChosen ? permission.handlerIds : [] },
        }),
      }),
    onSuccess: (s) => {
      setMedia(s.media);
      setMaintenance(s.maintenance);
      setPurchase(s.purchase);
      setPermission(s.permission);
      setMediaChosen(s.media.handlerIds.length > 0);
      setMaintenanceChosen(s.maintenance.assigneeIds.length > 0);
      setPurchaseChosen(s.purchase.handlerIds.length > 0);
      setPermissionChosen(s.permission.handlerIds.length > 0);
      void queryClient.invalidateQueries({ queryKey: ['request-modules'] });
      toast.success('Request types saved');
    },
    onError: fe.fail,
  });

  return (
    <CollapsibleCard
      id="request-types"
      icon={<Inbox className="size-4" />}
      title="Request types"
      description="Which kinds of request the household can make, and how each one works."
      group
    >
      <div className="space-y-5" {...fe.formProps}>
        <div data-field="media">
          <SectionCard
            title={REQUEST_CATEGORY_LABELS.media}
            description={REQUEST_MODULE_DESCRIPTIONS.media}
            aside={<StateBadge enabled={media.enabled} problem={missingHandlers || noMediaTypes} />}
            foldable
            openWhen={missingHandlers || noMediaTypes}
          >
            <div className="space-y-4">
              <Check label="On" checked={media.enabled} onChange={(on) => setMedia({ ...media, enabled: on })} />
              {media.enabled ? (
                <>
                  <CommonFields id="rt-media" defaultLabel={REQUEST_CATEGORY_LABELS.media} value={media} onChange={setMedia} />
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium">What can be asked for</legend>
                    <div className="flex flex-wrap gap-x-4 gap-y-2 pl-1">
                      {MEDIA_TYPES.map((t: MediaType) => (
                        <Check
                          key={t}
                          label={MEDIA_TYPE_SECTION_LABELS[t]}
                          checked={media.mediaTypes.includes(t)}
                          onChange={(on) => setMedia({ ...media, mediaTypes: toggle(media.mediaTypes, t, on) })}
                        />
                      ))}
                    </div>
                    <FieldNote
                      id="rt-media-types-note"
                      error={noMediaTypes ? 'Pick at least one, or turn Media off.' : null}
                    />
                  </fieldset>
                  <div className="space-y-2">
                    <Label htmlFor="rt-media-handlers">Who marks them added</Label>
                    <Select
                      id="rt-media-handlers"
                      value={mediaChosen ? 'chosen' : 'switch'}
                      onChange={(e) => setMediaChosen(e.target.value === 'chosen')}
                    >
                      <option value="switch">Everyone with Requests “Approve”</option>
                      <option value="chosen">Only the people I pick</option>
                    </Select>
                    {mediaChosen ? (
                      <PeoplePicker
                        members={members}
                        selected={media.handlerIds}
                        onChange={(ids) => setMedia({ ...media, handlerIds: ids })}
                      />
                    ) : null}
                    <FieldNote
                      id="rt-media-handlers-note"
                      error={missingHandlers ? 'Pick at least one person.' : null}
                      hint={mediaChosen ? undefined : 'Set in Members → Permissions. Out of the box: you and Managers.'}
                    />
                  </div>
                  <Check
                    label="They can decline a request, with a reason"
                    checked={media.allowDecline}
                    onChange={(on) => setMedia({ ...media, allowDecline: on })}
                  />
                </>
              ) : null}
            </div>
          </SectionCard>
        </div>

        <div data-field="maintenance">
          <SectionCard
            title={REQUEST_CATEGORY_LABELS.maintenance}
            description={REQUEST_MODULE_DESCRIPTIONS.maintenance}
            aside={<StateBadge enabled={maintenance.enabled} problem={missingAssignees} />}
            foldable
            openWhen={missingAssignees}
          >
            <div className="space-y-4">
              <Check
                label="On"
                checked={maintenance.enabled}
                onChange={(on) => setMaintenance({ ...maintenance, enabled: on })}
              />
              {maintenance.enabled ? (
                <>
                  <CommonFields
                    id="rt-maintenance"
                    defaultLabel={REQUEST_CATEGORY_LABELS.maintenance}
                    value={maintenance}
                    onChange={setMaintenance}
                  />
                  <div className="space-y-2">
                    <Label htmlFor="rt-maintenance-assignees">Who can be asked</Label>
                    <Select
                      id="rt-maintenance-assignees"
                      value={maintenanceChosen ? 'chosen' : 'anyone'}
                      onChange={(e) => setMaintenanceChosen(e.target.value === 'chosen')}
                    >
                      <option value="anyone">Anyone in the household</option>
                      <option value="chosen">Only the people I pick</option>
                    </Select>
                    {maintenanceChosen ? (
                      <PeoplePicker
                        members={members}
                        selected={maintenance.assigneeIds}
                        onChange={(ids) => setMaintenance({ ...maintenance, assigneeIds: ids })}
                      />
                    ) : null}
                    <FieldNote
                      id="rt-maintenance-assignees-note"
                      error={missingAssignees ? 'Pick at least one person.' : null}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="rt-maintenance-default">Picked to start with</Label>
                    <Select
                      id="rt-maintenance-default"
                      value={defaultAssigneeId ?? ''}
                      onChange={(e) => setMaintenance({ ...maintenance, defaultAssigneeId: e.target.value || null })}
                    >
                      <option value="">Nobody, they choose</option>
                      {askable.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </Select>
                    <FieldNote
                      id="rt-maintenance-default-note"
                      hint="They can still pick someone else. Never filled in for that person's own requests."
                    />
                  </div>
                  <Check
                    label="Accepting needs a done-by date"
                    checked={maintenance.requireDueDate}
                    onChange={(on) => setMaintenance({ ...maintenance, requireDueDate: on })}
                  />
                  <Check
                    label="The person asked can decline, with a reason"
                    checked={maintenance.allowDecline}
                    onChange={(on) => setMaintenance({ ...maintenance, allowDecline: on })}
                  />
                </>
              ) : null}
            </div>
          </SectionCard>
        </div>

        <DecisionSection
          id="rt-purchase"
          module="purchase"
          members={members}
          value={purchase}
          chosen={purchaseChosen}
          onChange={setPurchase}
          onChosenChange={setPurchaseChosen}
        />

        <DecisionSection
          id="rt-permission"
          module="permission"
          members={members}
          value={permission}
          chosen={permissionChosen}
          onChange={setPermission}
          onChosenChange={setPermissionChosen}
        />

        <div className="flex justify-end">
          <Button
            onClick={() => save.mutate()}
            disabled={
              save.isPending ||
              missingHandlers ||
              missingAssignees ||
              missingDeciders ||
              noMediaTypes
            }
          >
            {save.isPending ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
        </div>
      </div>
    </CollapsibleCard>
  );
}
