import type { Category } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import { logActivity } from '@/server/services/activityService';
import { ConflictError, NotFoundError } from '@/server/services/errors';
import type { CategoryAdminDTO } from '@/lib/types';
import type {
  CreateCategoryInput,
  ListCategoriesQuery,
  UpdateCategoryInput,
} from '@/lib/validation/category';

export function categoryToAdminDTO(c: Category): CategoryAdminDTO {
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    color: c.color,
    icon: c.icon,
  };
}

export async function listCategories(
  householdId: string,
  query: ListCategoriesQuery = {},
): Promise<CategoryAdminDTO[]> {
  const rows = await prisma.category.findMany({
    where: { householdId, kind: query.kind },
    orderBy: [{ kind: 'asc' }, { name: 'asc' }],
  });
  return rows.map(categoryToAdminDTO);
}

async function assertNameFree(
  householdId: string,
  name: string,
  kind: string,
  exceptId?: string,
): Promise<void> {
  const clash = await prisma.category.findFirst({
    where: {
      householdId,
      name,
      kind,
      NOT: exceptId ? { id: exceptId } : undefined,
    },
    select: { id: true },
  });
  if (clash) {
    throw new ConflictError(`A "${kind}" category named "${name}" already exists.`);
  }
}

export async function createCategory(
  householdId: string,
  userId: string,
  input: CreateCategoryInput,
): Promise<CategoryAdminDTO> {
  const name = input.name.trim();
  await assertNameFree(householdId, name, input.kind);
  const category = await prisma.category.create({
    data: {
      householdId,
      name,
      kind: input.kind,
      color: input.color ?? null,
      icon: input.icon ?? null,
    },
  });
  await logActivity({
    householdId,
    actorId: userId,
    verb: 'created',
    subjectType: 'category',
    subjectId: category.id,
    message: `created category "${name}"`,
  });
  return categoryToAdminDTO(category);
}

export async function updateCategory(
  householdId: string,
  userId: string,
  input: UpdateCategoryInput,
): Promise<CategoryAdminDTO> {
  const existing = await prisma.category.findFirst({
    where: { id: input.id, householdId },
  });
  if (!existing) throw new NotFoundError(`Category ${input.id} not found.`);

  const name = input.name?.trim() ?? existing.name;
  const kind = input.kind ?? existing.kind;
  if (name !== existing.name || kind !== existing.kind) {
    await assertNameFree(householdId, name, kind, existing.id);
  }

  const category = await prisma.category.update({
    where: { id: existing.id },
    data: {
      name,
      kind,
      color: input.color === undefined ? undefined : input.color,
      icon: input.icon === undefined ? undefined : input.icon,
    },
  });
  await logActivity({
    householdId,
    actorId: userId,
    verb: 'updated',
    subjectType: 'category',
    subjectId: category.id,
    message: `updated category "${category.name}"`,
  });
  return categoryToAdminDTO(category);
}

export async function deleteCategory(
  householdId: string,
  userId: string,
  id: string,
): Promise<void> {
  const existing = await prisma.category.findFirst({
    where: { id, householdId },
  });
  if (!existing) throw new NotFoundError(`Category ${id} not found.`);

  // Tasks / shopping / inventory references are set null by the schema.
  await prisma.category.delete({ where: { id } });
  await logActivity({
    householdId,
    actorId: userId,
    verb: 'deleted',
    subjectType: 'category',
    subjectId: id,
    message: `deleted category "${existing.name}"`,
  });
}
