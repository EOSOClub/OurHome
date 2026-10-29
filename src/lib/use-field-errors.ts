'use client';

import { useCallback, useMemo, useState, type SyntheticEvent } from 'react';
import { fieldErrors } from '@/lib/api';
import { toast } from '@/components/ui/toast';

/**
 * A form's field errors from the server (a 422, or a 403/409 naming its
 * field): which fields to mark and what to say under each, each kept until
 * that field is edited.
 *
 * ```tsx
 *   const fe = useFieldErrors('task');
 *   useMutation({ ..., onError: fe.fail })
 *   <form {...fe.formProps}>
 *     <div data-field="title">
 *       <Input {...fe.invalid('title')} />
 *       <FieldNote id={fe.noteId('title')} error={fe.get('title')} />
 *     </div>
 * ```
 *
 * Typing in (or clicking a button inside) an element with data-field="key"
 * clears that key; one element may name several ("roomIds floorIds").
 */
export function useFieldErrors(prefix = 'field') {
  const [errors, setErrors] = useState<Record<string, string>>({});

  /** A save failed: mark the fields the server named and say why (a local onError replaces the global toast). */
  const fail = useCallback((err: unknown) => {
    setErrors(fieldErrors(err));
    toast.error(err instanceof Error ? err.message : 'Something went wrong.');
  }, []);

  /** Only mark the fields: for a mutateAsync catch, where the global toast has already said why. */
  const mark = useCallback((err: unknown) => setErrors(fieldErrors(err)), []);

  /** [key] was edited (or every field, with no key): what the server said no longer applies. */
  const clear = useCallback((key?: string) => {
    setErrors((errs) => {
      if (key === undefined) return Object.keys(errs).length ? {} : errs;
      if (!(key in errs)) return errs;
      const next = { ...errs };
      delete next[key];
      return next;
    });
  }, []);

  const clearFrom = useCallback(
    (target: EventTarget | null) => {
      const el = target instanceof Element ? target.closest('[data-field]') : null;
      el?.getAttribute('data-field')?.split(/\s+/).filter(Boolean).forEach(clear);
    },
    [clear],
  );

  // Spread onto each <form> ({...fe.formProps}); the IDE doesn't follow the spread.
  // noinspection JSUnusedGlobalSymbols
  const formProps = useMemo(
    () => ({
      onChangeCapture: (e: SyntheticEvent) => clearFrom(e.target),
      // Day toggles, chips and the like are buttons: a click is their edit.
      onClickCapture: (e: SyntheticEvent) => {
        if (e.target instanceof Element && e.target.closest('button')) clearFrom(e.target);
      },
    }),
    [clearFrom],
  );

  return useMemo(() => {
    const noteId = (key: string) => `${prefix}-${key}-note`;
    return {
      errors,
      /** What's wrong with [key] (null if nothing is). */
      get: (key: string): string | null => errors[key] ?? null,
      has: (key: string): boolean => key in errors,
      /** The first of [keys] that's wrong (a field saved under several names). */
      first: (...keys: string[]): string | null => keys.map((k) => errors[k]).find(Boolean) ?? null,
      /** Any field is marked: hold the save until they're fixed. */
      any: Object.keys(errors).length > 0,
      /** The id of [key]'s FieldNote, for aria-describedby. */
      noteId,
      /** For the field's input: red while it's wrong, read out with its note. */
      invalid: (...keys: string[]) => ({
        'aria-invalid': keys.some((k) => k in errors) || undefined,
        'aria-describedby': noteId(keys[0]),
      }),
      fail,
      mark,
      clear,
      formProps,
    };
  }, [errors, fail, mark, clear, formProps, prefix]);
}

export type FieldErrorsState = ReturnType<typeof useFieldErrors>;
