// Step 12: the supervision list (parental controls) for the Members
// screenshots. Alex (the head) picks who supervises the kids: Alex and Sam
// look after Riley and Mia; Jordan, the roommate, supervises nobody.
// Through the API like the head would. Safe to run again: it sets the list.
import { clients, log } from './lib.mjs';

log('step 12: supervision list');
const C = await clients(['alex']);

const list = await C.alex.get('/api/supervision');
const byName = (name) => {
  const person = [...list.supervisors, ...list.supervised].find((p) => p.name.startsWith(name));
  if (!person) throw new Error(`no member called ${name}`);
  return person.id;
};
const parents = [byName('Alex'), byName('Sam')];
for (const kid of ['Riley', 'Mia']) {
  await C.alex.post('/api/supervision', { supervisedId: byName(kid), supervisorIds: parents });
  log(`  ${kid}: supervised by Alex and Sam`);
}
log('done');
