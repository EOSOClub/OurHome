# Maple House demo accounts

Server: http://localhost:3100 (DB ourhome_demo on localhost:27019, container ourhome_demo_mongo). All data is invented.

| Name | Username | Role | Password |
|---|---|---|---|
| Alex Morgan | alex | Head of House | DemoHouse!2026 |
| Sam Morgan | sam | Manager | DemoHouse!2026 |
| Jordan Lee | jordan | Member | DemoHouse!2026 |
| Riley Morgan | riley | Teen | DemoHouse!2026 |
| Mia Morgan | mia | Child | DemoHouse!2026 |

No account has a forced password change pending.

## Bills (open /bills/<id>)

- Mortgage, Lakeshore Home Loans (autopay, due Nov 1, 3 payments): `cmv3h8p9q018gnik4kgelwdyf` -> http://localhost:3100/bills/cmv3h8p9q018gnik4kgelwdyf
- Prairie Power & Light (due Oct 15, this week; Sep payment has a $2.95 card fee; account + invoice no.): `cmv3h8q46018xnik4w1x7mqdf` -> http://localhost:3100/bills/cmv3h8q46018xnik4w1x7mqdf
- Brookfield City Water & Sewer (OVERDUE, due Oct 6; account + invoice no.): `cmv3h8qhh019anik4kjiqjaqc` -> http://localhost:3100/bills/cmv3h8qhh019anik4kjiqjaqc
- Northwind Fiber 500 (autopay, due Oct 20): `cmv3h8qr2019jnik4kgt4epr9` -> http://localhost:3100/bills/cmv3h8qr2019jnik4kgt4epr9
- Bluebird Mobile (autopay, due Oct 13, this week): `cmv3h8r4e019wnik41txbg8cd` -> http://localhost:3100/bills/cmv3h8r4e019wnik41txbg8cd
- Harborline Auto Insurance (due Oct 24; account + invoice no.): `cmv3h8rj101a9nik44o8x09ia` -> http://localhost:3100/bills/cmv3h8rj101a9nik44o8x09ia
- StreamBox Premium (autopay, due Oct 24): `cmv3h8s0801amnik40u1bhtwu` -> http://localhost:3100/bills/cmv3h8s0801amnik40u1bhtwu
- Rivera Plumbing, one-off, paid: `cmv3h8sft01aynik4i2ktxey3` -> http://localhost:3100/bills/cmv3h8sft01aynik4i2ktxey3

## Tasks

- dishes: `cmv3h1029003wnik4htr8n7xb`
- counters: `cmv3h2sv800btnik4yhkxxfxc`
- cat: `cmv3h2z2v00fnnik4ogojwglw`
- bins: `cmv3h39p200minik40dl7znxu`
- vacuum: `cmv3h3buh00nznik4bx74v24m`
- laundry: `cmv3h3dy000pinik4ubw6cz65`
- bathroom: `cmv3h3hk500svnik4oijk9sdc`
- plants: `cmv3h3juu00v5nik43eowkicd`
- lawn: `cmv3h3mxn00xbnik4e6hkbfck`
- tidy: `cmv3h3ord00ylnik4ikhq9v04`
- fridge: `cmv3h3q8c00zmnik42gctlgn5`
- filter: `cmv3h3qqr0101nik4phe1kxga`
- door: `cmv3h3qta0105nik4i276gf4i`
- smoke: `cmv3h3qvv010bnik4m21obj3l`
- gutters: `cmv3h3qyg010jnik418i7io16`

Overdue: vacuum (Oct 10), lawn (Oct 10), furnace filter (Oct 6), smoke alarms (Oct 9). Laundry (due today) has 2 of 4 steps checked. 128 past completions across the last 6 weeks.

## Requests

- faucet: `cmv3h8utt01dqnik4vrwn5s0t`
- shelves: `cmv3h8uxm01dunik4sl08mpg7`
- porch: `cmv3h8vjp01e0nik4omi8og3c`
- lighthouse: `cmv3h8wek01e8nik4uduehbtf`
- robo: `cmv3h8wm701eenik4kjs3r9zj`
- starlight: `cmv3h8wq201einik4qgrllo3r`
- cedar: `cmv3h8wtf01emnik481heigbj`

faucet = open, shelves = accepted (done by Oct 18), porch = completed; lighthouse = movie marked added, cedar = TV show season 2.

## Inventory

- Coffee beans: `cmv3h8hfb013vnik490lwwp3d`
- Milk: `cmv3h8i43014dnik42sb3xa4q`
- Paper towels: `cmv3h8j2e0151nik46zlkh0zb`
- Dish soap: `cmv3h8jic015bnik4p0oc6rfi`
- Laundry detergent: `cmv3h8jv6015lnik4jsyhtshv`
- AA batteries: `cmv3h8kit015znik4gicm07c0`
- Toilet paper: `cmv3h8kvt0167nik4qs9o7d0d`
- Trash bags: `cmv3h8lud016nnik4xnci7d47`
- Eggs: `cmv3h8m98016vnik4mwpv2opj`
- Olive oil: `cmv3h8mu90177nik4chn2tf31`
- Cat food: `cmv3h8n3c017dnik4vunowfhx`
- Dishwasher pods: `cmv3h8noc017nnik4yo82einr`
- Sponges: `cmv3h8o7q017xnik4jsi5veus`
- Light bulbs: `cmv3h8ofy0183nik4v1mvgyfm`
- Hand soap refill: `cmv3h8onu0189nik4t2m47nfa`

Low: Coffee beans, Milk, Dish soap, Toilet paper.

## Other

- Shopping lists: Groceries `cmv3h732f010xnik4bpvq9pnh`, Hardware store `cmv3h735q0111nik45f2wthcm`
- NFC tags: pantry_coffee `cmv3h8xd901eqnik4loinytxa`, laundry_detergent `cmv3h8xho01eunik48a5ouksr`, room_laundry (location, Laundry) `cmv3h8xlh01eynik41z4e1x6m`
- Home Assistant integration "Home Assistant (LAN)": `cmv3h8yle01f6nik4sb7d9b1v` (token was shown once and not saved)
- Calendar events: 

Seed scripts: this folder `seed/` (01 to 10). `state.json` there holds the ids and session cookies.
