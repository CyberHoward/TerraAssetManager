# Anchor + Mirror yield optimizer bot

> :attention: You will need to **use your private key** to let the bot create and sign transactions. Make shure your firewall is configured accordingly and your device is properly secured.  
> **I decline all responsibility if you lose any money**. Using this bot is not riskless due to faulty configuration/bugs.

This bot prevents Anchor liquidations while also using excess aUST and UST to apply a delta-neutral farming strategy on Mirror. 
The CDPs of Anchor and Mirror are monitored and adjusted when needed. 

This bot uses parts from an anchor bot implementation by Romain Lanz (https://github.com/RomainLanz/anchor-borrow-bot)
<br />

## How it works

The bot fetches all relevent data related to your active positions. 
It uses this data to enshure solvency and maximize yield with the following priorities:


1. Anchor loan
  LTV higher then config.ltv.limit: Repayment needed
    - Enough cash (UST) on hand? 
    - Enough savings (aUST) on hand?
    - Get UST from Mirror positions
      - Unstake and withdraw needed LP from largest CDP asset (yields mAsset and UST) (1)
      - Burn mAsset to short CDP (decreases CDP LTV) (1)
      - Withdraw CDP collateral (aUST) to return CDP LTV to the same level as before. 
      - Withdraw claimed aUST from Anchor and repay loan.
  LTV lower then config.ltv.borrow: Borrow more
    - Borrow UST and deposit to Anchor
    
    
2. Mirror CDP
  collateralization ratio determined using asset+collateral minimum collateralization ration and an added margin (config.mOCR)
  Asset must be mintable (trading hours)
  
  Margin smaller then config.mORC.limit: Burn mAsset to CDP
    - Enough LP staked to repay? (1)
    - Enough mAssets in wallet? 
    - Enough collateral (aUST)?
    
  Margin greater then config.mORC.borrow: Mint mAsset from CDP (taking premium into account)
    - Mint and short mAsset
    - Buy equal ammount of mAsset 
    - Long farm mAsset
    
    
3. Excess aUST available? 
  - Deposit to CDP
  - Mint and short mAsset
  - Buy equal amount of mAsset
  - Long farm mAsset

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

TBA.

## Issues

If you have any issues with the bot, please, feel free to create one on this repository.

<br />

## Testing

If you would like to try the bot before running in production, you may want to use the Terra Tequila Testnet.
You can add fake money to your Testnet Wallet using https://faucet.terra.money/.

<br />

## Support

If you liked this bot feel free to buy me or Romain a coffee:
My address: `terra1gxsfv4ruvda37q3ta0kwx42w7qy5l9hf9l30sz`
Romain: `terra17lkkhegetxqua7s7g7k3xr9hxzcpvf8p878cnl`
