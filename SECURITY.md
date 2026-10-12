# Security Policy

OurHome holds a household's bills, documents, calendar, the inventory of the home and the sign-ins of everyone in it. If you find a way to get at that data, or to do something your role should not allow, please tell us privately so it can be fixed before anyone else finds it.

This policy covers all three OurHome repos: [OurHome](https://github.com/EOSOClub/OurHome) (the website and server), [OurHomeApp](https://github.com/EOSOClub/OurHomeApp) (the Android app) and [OurHomeServices](https://github.com/EOSOClub/OurHomeServices) (the supporting Docker stacks).

## How to report a security problem

**Please do not open a public issue.** A public issue tells everyone how to break in before there is a fix.

Report it privately on GitHub instead:

1. Go to the [Security tab](https://github.com/EOSOClub/OurHome/security) of the OurHome repo.
2. Click **Report a vulnerability**.
3. Fill in the form. Only the maintainer can see it.

Helpful things to include:

- What the problem is, and what someone could do with it.
- Which part it is in: the website, the Android app or the server setup.
- Steps to show it happening, or a small example.
- Which version you are running (the date or commit you installed).

Please do not test against someone else's OurHome server or real household data. Use your own install.

## What happens next

OurHome is built and looked after by one person in their spare time, so there is no fixed response time. Security reports go to the front of the queue. You will get a reply on the report, be kept up to date as it is fixed, and be credited in the fix if you would like to be.

## Which versions get fixes

OurHome has no numbered releases yet. Fixes go into the latest code on the `main` branch of each repo, so the way to get a fix is to update to the latest version.

## Problems in other software

The supporting stacks run MongoDB, Paperless-ngx and Proton Mail Bridge. A security problem in one of those programs themselves should go to that project. If the problem is in how OurHome sets them up or uses them, report it here.
