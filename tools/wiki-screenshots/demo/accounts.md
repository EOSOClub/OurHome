# Maple House demo accounts

Server: http://localhost:3100 (DB ourhome_demo on localhost:27019, container ourhome_demo_mongo). All data is invented.

| Name | Username | Role | Password |
|---|---|---|---|
| Alex Morgan | alex | Head of House | DemoHouse!2026 |
| Sam Morgan | sam | Manager | DemoHouse!2026 |
| Jordan Lee | jordan | Adult | DemoHouse!2026 |
| Riley Morgan | riley | Teen | DemoHouse!2026 |
| Mia Morgan | mia | Child | DemoHouse!2026 |

No account has a forced password change pending.

## Bills (open /bills/<id>)

- Mortgage, Lakeshore Home Loans (autopay, due Nov 1, 3 payments): `cmv4nlavq017cnitgvruggicb` -> http://localhost:3100/bills/cmv4nlavq017cnitgvruggicb
- Prairie Power & Light (due Oct 15, this week; Sep payment has a $2.95 card fee; account + invoice no.): `cmv4nlbex017tnitg6yno505x` -> http://localhost:3100/bills/cmv4nlbex017tnitg6yno505x
- Brookfield City Water & Sewer (OVERDUE, due Oct 6; account + invoice no.): `cmv4nlbqx0186nitghmcm037b` -> http://localhost:3100/bills/cmv4nlbqx0186nitghmcm037b
- Northwind Fiber 500 (autopay, due Oct 20): `cmv4nlc07018fnitgeaj52fk4` -> http://localhost:3100/bills/cmv4nlc07018fnitgeaj52fk4
- Bluebird Mobile (autopay, due Oct 13, this week): `cmv4nlce7018snitg2mf1ap79` -> http://localhost:3100/bills/cmv4nlce7018snitg2mf1ap79
- Harborline Auto Insurance (due Oct 24; account + invoice no.): `cmv4nlcqq0195nitgy932isko` -> http://localhost:3100/bills/cmv4nlcqq0195nitgy932isko
- StreamBox Premium (autopay, due Oct 24): `cmv4nld33019initg68rku1d2` -> http://localhost:3100/bills/cmv4nld33019initg68rku1d2
- Rivera Plumbing, one-off, paid: `cmv4nldfj019unitg1ura1olr` -> http://localhost:3100/bills/cmv4nldfj019unitg1ura1olr

## Tasks

- dishes: `cmv4niwjp0048nitg0t7o0w0t`
- counters: `cmv4nj78900bynitgkp5xffip`
- cat: `cmv4njcow00funitg68zzz9s4`
- bins: `cmv4njm6h00menitgo4ltql8m`
- vacuum: `cmv4njogh00nvnitgonobyx5x`
- laundry: `cmv4njqng00penitgmuia9tos`
- bathroom: `cmv4nju9v00stnitgj7bkehqs`
- plants: `cmv4njwlu00v3nitgf8kkpdrh`
- lawn: `cmv4nkbk700xgnitg45asz04c`
- tidy: `cmv4nkcyw00yjnitgae3i8r42`
- fridge: `cmv4nkehe00zknitgvqpvcix5`
- filter: `cmv4nkex300zznitg7pu399nx`
- door: `cmv4nkez00103nitg1qxlce31`
- smoke: `cmv4nkf0y0109nitgutdaw6ni`
- gutters: `cmv4nkf38010hnitgxbf36nub`

Overdue: vacuum (Oct 10), lawn (Oct 10), furnace filter (Oct 6), smoke alarms (Oct 9). Laundry (due today) has 2 of 4 steps checked. 128 past completions across the last 6 weeks.

## Requests

- faucet: `cmv4nlew101cmnitgaygp3dhq`
- shelves: `cmv4nlezi01cqnitg7ow2svmk`
- porch: `cmv4nlf7901cwnitgig5c4elc`
- lighthouse: `cmv4nlfid01d4nitgiufo4yob`
- robo: `cmv4nlfp801danitge1u64lja`
- starlight: `cmv4nlftb01denitg45waqxp6`
- cedar: `cmv4nlfx401dinitgmel9mwum`

faucet = open, shelves = accepted (done by Oct 18), porch = completed; lighthouse = movie marked added, cedar = TV show season 2.

## Inventory

- Coffee beans: `cmv4nl43d012rnitg9vdtigtw`
- Milk: `cmv4nl4qp0139nitgmg7xn47q`
- Paper towels: `cmv4nl5ma013xnitg5j43em3d`
- Dish soap: `cmv4nl60z0147nitg2xo4qhct`
- Laundry detergent: `cmv4nl6ci014hnitgi9iehm6d`
- AA batteries: `cmv4nl6yi014vnitgaklv5nge`
- Toilet paper: `cmv4nl7ak0153nitg01iv99go`
- Trash bags: `cmv4nl7wv015jnitg3g8jbvmw`
- Eggs: `cmv4nl87n015rnitgp8yo8uw6`
- Olive oil: `cmv4nl8qk0163nitgjk4hyshl`
- Cat food: `cmv4nl8yu0169nitg2qhw8f01`
- Dishwasher pods: `cmv4nl9lr016jnitggul1gaqf`
- Sponges: `cmv4nla56016tnitgw6bb3znk`
- Light bulbs: `cmv4nladk016znitguwloq7qj`
- Hand soap refill: `cmv4nlalv0175nitgvjerr03v`

Low: Coffee beans, Milk, Dish soap, Toilet paper.

## Other

- Shopping lists: Groceries `cmv4nl2cj010vnitg7kzlhswt`, Hardware store `cmv4nl2fy010znitg5tytnw41`
- NFC tags: pantry_coffee `cmv4nlg2y01dmnitgzz2g3xzs`, laundry_detergent `cmv4nlg6n01dqnitgzacayt6g`, room_laundry (location, Laundry) `cmv4nlg9w01dunitg5mux4h7j`
- Home Assistant integration "Home Assistant (LAN)": `cmv4nlgk301e2nitg1mai6d9i` (token was shown once and not saved)
- Calendar events: 

Seed scripts: this folder `seed/` (01 to 10). `state.json` there holds the ids and session cookies.
