# Anchor Borrow / Repay bot

The main goal of this bot is to avoid being liquidated due to the price volatility of bLuna, by repaying part of your debt when the LTV is too high.

> :warning: You will need to **use your private key** to let the bot create and sign transactions.
> We highly recommend to **create a dedicated wallet** and **we decline all responsibility if you lose any money**.

<br />

## How it Works?

The bot will fetch your current LTV every X seconds (10 per default).

If your LTV is higher than `ltv.limit` (43% per default), the bot will try to repay the sum needed to make your LTV back at `ltv.safe` (35% per default).

1. We verify the balance of your wallet to see if you have enough money to repay;
2. We verify the balance of your deposit to see if you can withdraw from it to repay;
3. We verify if you have any unclaimed reward that we can claim and sell to repay;
4. :construction: We verify if you have any token stake in governance that we can unstake and sell to repay ([#3](https://github.com/RomainLanz/anchor-borrow-bot/issues/)).

> :information_source: If we need to claim any rewards, we will sell only the required amount and stake in governance the rest of your token.

If your LTV is lower than `ltv.borrow` (30% per default), the bot will borrow more to reach the `ltv.safe` (35% per default), then it will deposit the amount borrowed.

<br />

## Installation

You will need to have `Node.js` installed on your system to run this bot.
We highly recommend you to use [`volta.sh`](https://volta.sh/) or [`nvm`](https://github.com/nvm-sh/nvm) to manage your `Node.js` version.

> :information_source: The bot has been tested with Node.js 16.2.0, on Windows, Linux & macOS.

Once you have `node` and `npm` accessible in your terminal's path, you will need to do the following:

1. Clone the repository;
2. Install its dependencies (`npm install`);
3. Copy the `.env.example` file to `.env` and fill all values (`cp .env.example .env`);
4. Run the bot with `npm run start`.

> :information_source: We recommend using a tool like [`pm2`](https://github.com/Unitech/pm2) to run the bot in a background process.

<br />

## Setup Telegram Bot

This bot will notify you via a Telegram Bot for any transactions.

You need to create your Telegram Bot to activate this feature. It can be quickly done [via the Telegram application](https://core.telegram.org/bots#6-botfather).
Once you have your `token` and your `chat_id` you can define those variables inside the `.env` file.

> :information_source: The `chat_id` is your user ID. You can have it when sending `/getid` to [IDBot](https://t.me/myidbot).

You will also be able to control the bot via some commands.

- `/ping` - Will answer you `Pong!`;
- `/ltv` - Will give you your current LTV;
- `/goto X` - Will repay or borrow to change your LTV according to X
- `/set X Y` - Will change runtime configuration (ie: `/set ltv.borrow 20`)

<br />

## Testing

If you would like to try the bot before running in production, you may want to use the Terra Testnet.
You can add fake money to your Testnet Wallet using https://faucet.terra.money/.

We also provide a dry-run option to not execute any transactions and only notify you ([#6](https://github.com/RomainLanz/anchor-borrow-bot/issues/6)).
