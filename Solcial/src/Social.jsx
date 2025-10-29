import React, { useState, useEffect, useMemo, Component } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { Program, AnchorProvider, web3, BN } from '@project-serum/anchor';
import { PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, ComputeBudgetProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from '@solana/spl-token';
import bs58 from 'bs58';
import { ethers } from 'ethers';

// Define missing constants
const DEBRIDGE_API_BASE = 'https://dln.debridge.finance/v1.0/dln';
const AFFILIATE_PERCENT = 2; // Example: 0.25% (25 basis points)
const AFFILIATE_RECIPIENT = '0x8768387832187D108612009436341aaed5132849'; // Replace with actual ETH address
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SOL_DECIMALS = 9;
const BASE_BRIDGE_AMOUNT = 0.012;

// Limited input tokens for bridging (example set, adjust as needed)
const LIMITED_INPUT_TOKENS = [
  {
    label: 'ETH on Ethereum',
    chain: 1,
    token: '0x0000000000000000000000000000000000000000',
    decimals: 18,
    coingeckoId: 'ethereum',
  },
  {
    label: 'BNB on BNB Chain',
    chain: 56,
    token: '0x0000000000000000000000000000000000000000',
    decimals: 18,
    coingeckoId: 'binancecoin',
  },
  // Add more as needed, e.g., USDC on Ethereum
  // {
  //   label: 'USDC on Ethereum',
  //   chain: 1,
  //   token: '0xa0b86991c6218b36c1d19f4a2e9eb0ce3606eb48',
  //   decimals: 6,
  //   coingeckoId: 'usd-coin',
  // },
];

// Error Boundary Component
class ErrorBoundary extends Component {
  state = { hasError: false };

  static getDerivedStateFromError(error) {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="text-center text-red-400 p-8">
          <h1>Something went wrong.</h1>
          <p>Please refresh the page or try again later.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

// Retry function for RPC rate-limiting
const withRetry = async (fn, maxRetries = 5, baseDelay = 1000) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err.message.includes('429') || err.message.includes('Too Many Requests')) {
        if (attempt === maxRetries) throw new Error('Max retries reached due to rate limiting');
        const delay = baseDelay * 2 ** (attempt - 1) + Math.random() * 100;
        console.warn(`Rate limit hit, retrying in ${delay}ms... (Attempt ${attempt}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw err;
      }
    }
  }
};

// Enhanced sendAndConfirm with graceful error handling
const sendAndConfirmWithRetry = async (provider, transaction, maxRetries = 5, baseDelay = 1000) => {
  let finalSignature = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { blockhash, lastValidBlockHeight } = await withRetry(() =>
        provider.connection.getLatestBlockhash('confirmed')
      );
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = provider.wallet.publicKey;

      const serializedTx = bs58.encode(transaction.serialize({ requireAllSignatures: false }));
      console.log('Serialized transaction:', serializedTx);

      let simulationResult;
      try {
        simulationResult = await withRetry(() =>
          provider.connection.simulateTransaction(transaction, {
            commitment: 'confirmed',
            sigVerify: false,
          })
        );
        if (simulationResult.value.err) {
          console.warn(`Simulation failed on attempt ${attempt}:`, simulationResult.value.err, 'Logs:', simulationResult.value.logs);
          if (attempt === maxRetries) {
            throw new Error(`Simulation failed: ${JSON.stringify(simulationResult.value.err)}. Logs: ${JSON.stringify(simulationResult.value.logs)}`);
          }
          console.log('Retrying after simulation failure...');
          continue;
        }
        console.log('Simulation succeeded:', simulationResult.value.logs);
      } catch (simErr) {
        console.warn(`Simulation error on attempt ${attempt}:`, simErr.message);
        if (attempt === maxRetries) {
          console.log('Attempting to send transaction despite simulation failure...');
        } else {
          continue;
        }
      }

      const signature = await provider.sendAndConfirm(transaction, [], {
        commitment: 'confirmed',
        maxRetries: 0,
        skipPreflight: false,
      });

      finalSignature = signature;
      console.log('Transaction sent, signature:', signature);

      try {
        if (typeof signature !== 'string') {
          throw new Error(`Invalid signature type: expected string, got ${typeof signature}`);
        }

        const status = await withRetry(() =>
          provider.connection.getTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          })
        );

        if (!status) {
          console.warn(`Transaction not found after sending: ${signature}, but this may be temporary`);
        } else if (status.meta?.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(status.meta.err)}`);
        } else {
          console.log('Transaction confirmed, signature:', signature);
        }
      } catch (confirmErr) {
        console.warn('Error confirming transaction, but transaction may have succeeded:', confirmErr.message);
        if (confirmErr.message.includes('WrongSize') ||
            confirmErr.message.includes('Invalid param') ||
            confirmErr.message.includes('failed to get transaction')) {
          console.log('Confirmation error detected, but transaction likely succeeded. Returning signature.');
          return signature;
        }
        if (finalSignature) {
          console.log('Returning signature despite confirmation error:', finalSignature);
          return finalSignature;
        }
        throw confirmErr;
      }

      return signature;

    } catch (err) {
      console.error(`Attempt ${attempt} failed:`, err);

      if (err.message.includes('Invalid arguments')) {
        console.warn('Caught Invalid arguments error, checking transaction details...');
        const logs = await err.getLogs?.(provider.connection) || [];
        console.error('Transaction logs:', logs);
        if (attempt === maxRetries) {
          throw new Error(`Invalid arguments error: ${err.message}. Logs: ${JSON.stringify(logs)}`);
        }
        console.log('Retrying with fresh blockhash and transaction...');
        transaction.signatures = [];
        continue;
      } else if (err.message.includes('Invalid params: invalid type: map, expected a string') ||
                 err.message.includes('WrongSize') ||
                 err.message.includes('failed to get transaction')) {
        console.warn('Caught RPC confirmation error, but transaction may have succeeded');
        if (finalSignature) {
          console.log('Returning final signature despite RPC error:', finalSignature);
          return finalSignature;
        }
        if (attempt < maxRetries) {
          console.log('Retrying with fresh transaction serialization...');
          transaction.signatures = [];
          continue;
        }
        throw new Error(`Max retries reached: ${err.message}`);
      } else if (err.message.includes('This transaction has already been processed')) {
        console.warn(`Transaction already processed on attempt ${attempt}, checking status...`);
        const signature = typeof transaction.signatures[0] === 'string'
          ? transaction.signatures[0]
          : bs58.encode(transaction.signatures[0]?.signature || Buffer.from([]));

        try {
          const status = await withRetry(() =>
            provider.connection.getTransaction(signature, {
              commitment: 'confirmed',
              maxSupportedTransactionVersion: 0,
            })
          );
          if (status && !status.meta?.err) {
            console.log('Transaction was already processed successfully:', signature);
            return signature;
          }
        } catch (checkErr) {
          console.warn('Could not verify already processed transaction:', checkErr.message);
        }

        throw new Error('Transaction already processed but failed or not found');
      } else if (err.message.includes('Blockhash not found') || err.message.includes('TransactionExpiredBlockheightExceededError')) {
        console.warn(`Blockhash expired on attempt ${attempt}, retrying with fresh blockhash...`);
        continue;
      } else if (err.name === 'SendTransactionError') {
        const logs = await err.getLogs?.(provider.connection) || [];
        console.error('Transaction logs:', logs);
        if (attempt === maxRetries) {
          throw new Error(`Transaction failed after ${maxRetries} attempts: ${err.message}. Logs: ${JSON.stringify(logs)}`);
        }
        const delay = baseDelay * 2 ** (attempt - 1) + Math.random() * 100;
        console.warn(`Retrying transaction in ${delay}ms... (Attempt ${attempt}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw err;
      }
    }
  }
};

// Hardcoded admin and moderator public keys from the Solana program
const ADMIN_PUBLIC_KEY = new PublicKey('HrsKTCmdRrvfsknwVwnVguWFXQpLTdgCwQ8nwfFXvvLz');
const MODERATOR_PUBLIC_KEYS = [
  new PublicKey('7XeCnBHGWYxpVfd9zCoU3z8FtiSwoGZYk41jcE2sgBxW'),
  new PublicKey('5n7BhkbShhh4LCKngM6z7kzKmFaM9jTmJ8XYpzSE7BXU'),
  new PublicKey('HaNAWXNe3ZUwDKsTA8feKL43r4ViqaNAzzZGWixUvncp'),
];
const POST_FEE_RECIPIENT = new PublicKey('5n7BhkbShhh4LCKngM6z7kzKmFaM9jTmJ8XYpzSE7BXU');
const SOLCIAL_MINT = new PublicKey('5Rbao9ekiUJbYteTjhYKif5VF95oZxfUy1ZGb5Mc9CYj');
const SOLCIAL_RECIPIENT = new PublicKey('5n7BhkbShhh4LCKngM6z7kzKmFaM9jTmJ8XYpzSE7BXU');

// Updated program ID
const programID = new PublicKey('2AMLveNaFm7tysy3moFyshsW6Q9qoBJPRcaEL3vEhuzt');

// Constants for fees (from Solana program)
const POST_FEE = 0.001; // SOL
const REPLY_FEE = 0.005; // SOL
const VOTE_FEE = 0.001; // SOL
const REPORT_FEE = 0.002; // SOL
const SOLCIAL_POST_FEE = 1000; // SOLCIAL tokens
const SOLCIAL_REPLY_FEE = 5000; // SOLCIAL tokens
const SOLCIAL_VOTE_FEE = 1000; // SOLCIAL tokens
const SOLCIAL_REPORT_FEE = 200; // SOLCIAL tokens

// Updated IDL
const idl = {
  "version": "0.1.0",
  "name": "solana_forum",
  "instructions": [
    {
      "name": "initializeForum",
      "accounts": [
        {
          "name": "forum",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "admin",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": []
    },
    {
      "name": "createPost",
      "accounts": [
        {
          "name": "post",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "forum",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "user",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "feeRecipient",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "content",
          "type": "string"
        }
      ]
    },
    {
      "name": "createPostWithSolcial",
      "accounts": [
        {
          "name": "post",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "forum",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "user",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "userSolcialAccount",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "solcialRecipient",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "solcialMint",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "tokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "content",
          "type": "string"
        }
      ]
    },
    {
      "name": "createReply",
      "accounts": [
        {
          "name": "reply",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "forum",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "post",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "user",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "postAuthor",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "content",
          "type": "string"
        }
      ]
    },
    {
      "name": "createReplyWithSolcial",
      "accounts": [
        {
          "name": "reply",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "forum",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "post",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "user",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "userSolcialAccount",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "postAuthorSolcialAccount",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "solcialMint",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "tokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "content",
          "type": "string"
        }
      ]
    },
    {
      "name": "ratePost",
      "accounts": [
        {
          "name": "post",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "userRating",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "user",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "forum",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "postAuthor",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "isUpvote",
          "type": "bool"
        }
      ]
    },
    {
      "name": "ratePostWithSolcial",
      "accounts": [
        {
          "name": "post",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "userRating",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "user",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "forum",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "userSolcialAccount",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "postAuthorSolcialAccount",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "solcialRecipient",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "solcialMint",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "tokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "isUpvote",
          "type": "bool"
        }
      ]
    },
    {
      "name": "rateReply",
      "accounts": [
        {
          "name": "reply",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "userRating",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "user",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "forum",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "post",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "postAuthor",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "isUpvote",
          "type": "bool"
        }
      ]
    },
    {
      "name": "rateReplyWithSolcial",
      "accounts": [
        {
          "name": "reply",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "userRating",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "user",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "forum",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "post",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "userSolcialAccount",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "postAuthorSolcialAccount",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "solcialRecipient",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "solcialMint",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "tokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "isUpvote",
          "type": "bool"
        }
      ]
    },
    {
      "name": "reportPost",
      "accounts": [
        {
          "name": "report",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "post",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "forum",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "user",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "feeRecipient",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "reason",
          "type": "string"
        }
      ]
    },
    {
      "name": "reportPostWithSolcial",
      "accounts": [
        {
          "name": "report",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "post",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "forum",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "user",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "userSolcialAccount",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "solcialRecipient",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "solcialMint",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "tokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "reason",
          "type": "string"
        }
      ]
    },
    {
      "name": "reportReply",
      "accounts": [
        {
          "name": "report",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "reply",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "forum",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "user",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "feeRecipient",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "reason",
          "type": "string"
        }
      ]
    },
    {
      "name": "reportReplyWithSolcial",
      "accounts": [
        {
          "name": "report",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "reply",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "forum",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "user",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "userSolcialAccount",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "solcialRecipient",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "solcialMint",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "tokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "reason",
          "type": "string"
        }
      ]
    },
    {
      "name": "resolveReport",
      "accounts": [
        {
          "name": "report",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "forum",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "admin",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "actionTaken",
          "type": "string"
        }
      ]
    },
    {
      "name": "resolveReplyReport",
      "accounts": [
        {
          "name": "report",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "forum",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "admin",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "actionTaken",
          "type": "string"
        }
      ]
    },
    {
      "name": "deletePost",
      "accounts": [
        {
          "name": "post",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "forum",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "admin",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": []
    },
    {
      "name": "deleteReply",
      "accounts": [
        {
          "name": "reply",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "forum",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "admin",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": []
    },
    {
      "name": "closePostReport",
      "accounts": [
        {
          "name": "report",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "admin",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": []
    },
    {
      "name": "closeReplyReport",
      "accounts": [
        {
          "name": "report",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "admin",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": []
    },
    {
      "name": "closeForum",
      "accounts": [
        {
          "name": "forum",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "admin",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "Forum",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "publicKey"
          },
          {
            "name": "postCount",
            "type": "u64"
          },
          {
            "name": "replyCount",
            "type": "u64"
          },
          {
            "name": "reportCount",
            "type": "u64"
          },
          {
            "name": "version",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "Post",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "author",
            "type": "publicKey"
          },
          {
            "name": "content",
            "type": "string"
          },
          {
            "name": "rating",
            "type": "i64"
          },
          {
            "name": "timestamp",
            "type": "i64"
          },
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "isReported",
            "type": "bool"
          },
          {
            "name": "reportCount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "Reply",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "author",
            "type": "publicKey"
          },
          {
            "name": "content",
            "type": "string"
          },
          {
            "name": "rating",
            "type": "i64"
          },
          {
            "name": "timestamp",
            "type": "i64"
          },
          {
            "name": "postId",
            "type": "u64"
          },
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "isReported",
            "type": "bool"
          },
          {
            "name": "reportCount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "UserRating",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "hasRated",
            "type": "bool"
          },
          {
            "name": "isUpvote",
            "type": "bool"
          },
          {
            "name": "ratingTimestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "PostReport",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "reporter",
            "type": "publicKey"
          },
          {
            "name": "postId",
            "type": "u64"
          },
          {
            "name": "reason",
            "type": "string"
          },
          {
            "name": "timestamp",
            "type": "i64"
          },
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "isResolved",
            "type": "bool"
          },
          {
            "name": "resolutionTimestamp",
            "type": "i64"
          },
          {
            "name": "adminAction",
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "ReplyReport",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "reporter",
            "type": "publicKey"
          },
          {
            "name": "replyId",
            "type": "u64"
          },
          {
            "name": "reason",
            "type": "string"
          },
          {
            "name": "timestamp",
            "type": "i64"
          },
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "isResolved",
            "type": "bool"
          },
          {
            "name": "resolutionTimestamp",
            "type": "i64"
          },
          {
            "name": "adminAction",
            "type": "string"
          }
        ]
      }
    }
  ],
  "events": [
    {
      "name": "ForumInitialized",
      "fields": [
        {
          "name": "admin",
          "type": "publicKey",
          "index": false
        },
        {
          "name": "version",
          "type": "u64",
          "index": false
        }
      ]
    },
    {
      "name": "PostCreated",
      "fields": [
        {
          "name": "postId",
          "type": "u64",
          "index": false
        },
        {
          "name": "author",
          "type": "publicKey",
          "index": false
        },
        {
          "name": "content",
          "type": "string",
          "index": false
        },
        {
          "name": "timestamp",
          "type": "i64",
          "index": false
        },
        {
          "name": "pda",
          "type": "publicKey",
          "index": false
        }
      ]
    },
    {
      "name": "ReplyCreated",
      "fields": [
        {
          "name": "replyId",
          "type": "u64",
          "index": false
        },
        {
          "name": "postId",
          "type": "u64",
          "index": false
        },
        {
          "name": "author",
          "type": "publicKey",
          "index": false
        },
        {
          "name": "content",
          "type": "string",
          "index": false
        },
        {
          "name": "timestamp",
          "type": "i64",
          "index": false
        },
        {
          "name": "pda",
          "type": "publicKey",
          "index": false
        }
      ]
    },
    {
      "name": "PostRated",
      "fields": [
        {
          "name": "postId",
          "type": "u64",
          "index": false
        },
        {
          "name": "user",
          "type": "publicKey",
          "index": false
        },
        {
          "name": "isUpvote",
          "type": "bool",
          "index": false
        },
        {
          "name": "newRating",
          "type": "i64",
          "index": false
        },
        {
          "name": "timestamp",
          "type": "i64",
          "index": false
        }
      ]
    },
    {
      "name": "ReplyRated",
      "fields": [
        {
          "name": "replyId",
          "type": "u64",
          "index": false
        },
        {
          "name": "postId",
          "type": "u64",
          "index": false
        },
        {
          "name": "user",
          "type": "publicKey",
          "index": false
        },
        {
          "name": "isUpvote",
          "type": "bool",
          "index": false
        },
        {
          "name": "newRating",
          "type": "i64",
          "index": false
        },
        {
          "name": "timestamp",
          "type": "i64",
          "index": false
        }
      ]
    },
    {
      "name": "PostReported",
      "fields": [
        {
          "name": "reportId",
          "type": "u64",
          "index": false
        },
        {
          "name": "postId",
          "type": "u64",
          "index": false
        },
        {
          "name": "reporter",
          "type": "publicKey",
          "index": false
        },
        {
          "name": "reason",
          "type": "string",
          "index": false
        },
        {
          "name": "timestamp",
          "type": "i64",
          "index": false
        },
        {
          "name": "pda",
          "type": "publicKey",
          "index": false
        }
      ]
    },
    {
      "name": "ReplyReported",
      "fields": [
        {
          "name": "reportId",
          "type": "u64",
          "index": false
        },
        {
          "name": "replyId",
          "type": "u64",
          "index": false
        },
        {
          "name": "reporter",
          "type": "publicKey",
          "index": false
        },
        {
          "name": "reason",
          "type": "string",
          "index": false
        },
        {
          "name": "timestamp",
          "type": "i64",
          "index": false
        },
        {
          "name": "pda",
          "type": "publicKey",
          "index": false
        }
      ]
    },
    {
      "name": "PostReportResolved",
      "fields": [
        {
          "name": "reportId",
          "type": "u64",
          "index": false
        },
        {
          "name": "postId",
          "type": "u64",
          "index": false
        },
        {
          "name": "admin",
          "type": "publicKey",
          "index": false
        },
        {
          "name": "actionTaken",
          "type": "string",
          "index": false
        },
        {
          "name": "timestamp",
          "type": "i64",
          "index": false
        }
      ]
    },
    {
      "name": "ReplyReportResolved",
      "fields": [
        {
          "name": "reportId",
          "type": "u64",
          "index": false
        },
        {
          "name": "replyId",
          "type": "u64",
          "index": false
        },
        {
          "name": "admin",
          "type": "publicKey",
          "index": false
        },
        {
          "name": "actionTaken",
          "type": "string",
          "index": false
        },
        {
          "name": "timestamp",
          "type": "i64",
          "index": false
        }
      ]
    },
    {
      "name": "PostDeleted",
      "fields": [
        {
          "name": "postId",
          "type": "u64",
          "index": false
        },
        {
          "name": "admin",
          "type": "publicKey",
          "index": false
        }
      ]
    },
    {
      "name": "ReplyDeleted",
      "fields": [
        {
          "name": "replyId",
          "type": "u64",
          "index": false
        },
        {
          "name": "postId",
          "type": "u64",
          "index": false
        },
        {
          "name": "admin",
          "type": "publicKey",
          "index": false
        }
      ]
    },
    {
      "name": "PostReportClosed",
      "fields": [
        {
          "name": "reportId",
          "type": "u64",
          "index": false
        },
        {
          "name": "admin",
          "type": "publicKey",
          "index": false
        }
      ]
    },
    {
      "name": "ReplyReportClosed",
      "fields": [
        {
          "name": "reportId",
          "type": "u64",
          "index": false
        },
        {
          "name": "admin",
          "type": "publicKey",
          "index": false
        }
      ]
    },
    {
      "name": "ForumClosed",
      "fields": [
        {
          "name": "admin",
          "type": "publicKey",
          "index": false
        }
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "NotAdmin",
      "msg": "Only admin can perform this action"
    },
    {
      "code": 6001,
      "name": "ContentTooLong",
      "msg": "Content exceeds maximum length"
    },
    {
      "code": 6002,
      "name": "ContentEmpty",
      "msg": "Content cannot be empty"
    },
    {
      "code": 6003,
      "name": "InvalidPostId",
      "msg": "Invalid post ID"
    },
    {
      "code": 6004,
      "name": "InvalidReplyId",
      "msg": "Invalid reply ID"
    },
    {
      "code": 6005,
      "name": "InsufficientLamports",
      "msg": "Insufficient lamports for transaction"
    },
    {
      "code": 6006,
      "name": "InvalidFeeRecipient",
      "msg": "Invalid fee recipient"
    },
    {
      "code": 6007,
      "name": "FeeRecipientNotInitialized",
      "msg": "Fee recipient account not initialized"
    },
    {
      "code": 6008,
      "name": "InvalidFeeRecipientOwner",
      "msg": "Invalid fee recipient owner"
    },
    {
      "code": 6009,
      "name": "ReportReasonTooLong",
      "msg": "Report reason exceeds maximum length"
    },
    {
      "code": 6010,
      "name": "ReportReasonEmpty",
      "msg": "Report reason cannot be empty"
    },
    {
      "code": 6011,
      "name": "MaxReportsReached",
      "msg": "Maximum number of reports for post reached"
    },
    {
      "code": 6012,
      "name": "ReportAlreadyResolved",
      "msg": "Report already resolved"
    },
    {
      "code": 6013,
      "name": "InvalidAuthor",
      "msg": "Invalid author address"
    },
    {
      "code": 6014,
      "name": "InvalidSolcialMint",
      "msg": "Invalid SOLCIAL mint"
    },
    {
      "code": 6015,
      "name": "InvalidSolcialRecipient",
      "msg": "Invalid SOLCIAL recipient"
    },
    {
      "code": 6016,
      "name": "AccountFrozen",
      "msg": "Token account is frozen"
    },
    {
      "code": 6017,
      "name": "InsufficientTokens",
      "msg": "Insufficient tokens for transaction"
    },
    {
      "code": 6018,
      "name": "InvalidTokenOwner",
      "msg": "Invalid token owner"
    },
    {
      "code": 6019,
      "name": "InvalidContent",
      "msg": "Invalid content characters"
    },
    {
      "code": 6020,
      "name": "InvalidPDA",
      "msg": "Invalid PDA"
    }
  ]
};

export default function Social() {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const [forum, setForum] = useState(null);
  const [posts, setPosts] = useState([]);
  const [replies, setReplies] = useState([]);
  const [postReports, setPostReports] = useState([]);
  const [replyReports, setReplyReports] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showCreatePost, setShowCreatePost] = useState(false);
  const [newPostContent, setNewPostContent] = useState('');
  const [newPostCategory, setNewPostCategory] = useState('General Chatting');
  const [useSolcial, setUseSolcial] = useState(false);
  const [solcialBalance, setSolcialBalance] = useState(null);
  const [showReplyForm, setShowReplyForm] = useState({});
  const [newReplyContent, setNewReplyContent] = useState({});
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [isFetching, setIsFetching] = useState(false);
  const [forumPda, setForumPda] = useState(null);
  const [activeSection, setActiveSection] = useState('All');
  const [starredPosts, setStarredPosts] = useState([]);
  const [showUserPosts, setShowUserPosts] = useState(false);
  const [showReportModal, setShowReportModal] = useState({ show: false, type: null, id: null });
  const [reportReason, setReportReason] = useState('');
  const [showWhitepaper, setShowWhitepaper] = useState(false);
  const [showBridge, setShowBridge] = useState(false);
  const [evmProvider, setEvmProvider] = useState(null);
  const [evmAddress, setEvmAddress] = useState(null);
  const [selectedInput, setSelectedInput] = useState(null);
  const [bridgeAmount, setBridgeAmount] = useState('');
  const [estimationInfo, setEstimationInfo] = useState(null);

  // Separate state for bridge post content
  const [bridgePostContent, setBridgePostContent] = useState('');
  const [bridgePostCategory, setBridgePostCategory] = useState('General Chatting');

  // RPC Endpoints
  const MAINNET_RPC = 'https://mainnet.helius-rpc.com/?api-key=1acf2b1f-c36d-48f7-9b05-78460140c308&rebate-address=CGRRDgVxr2WKyz5oaRR4YMdwrdub3xPz9PUEtWMtUi7R';
  const FALLBACK_RPC = 'https://mainnet.helius-rpc.com/?api-key=39dd454b-83ae-4ba4-9ca2-7d5b203ded7d&rebate-address=CGRRDgVxr2WKyz5oaRR4YMdwrdub3xPz9PUEtWMtUi7R';

 // Connection with fallback
const connectionMemo = useMemo(() => {
  try {
    const connection = new web3.Connection(MAINNET_RPC, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000,
      disableRetryOnRateLimit: false,
      wsEndpoint: MAINNET_RPC.replace('https', 'wss'),
    });
    return connection;
  } catch (err) {
    console.warn('Mainnet RPC failed, falling back to secondary RPC:', err.message);
    try {
      const fallbackConnection = new web3.Connection(FALLBACK_RPC, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 60000,
        disableRetryOnRateLimit: false,
        wsEndpoint: FALLBACK_RPC.replace('https', 'wss'),
      });
      return fallbackConnection;
    } catch (fallbackErr) {
      console.warn('Fallback RPC failed, using default connection:', fallbackErr.message);
      return connection;
    }
  }
}, [connection]);

  const provider = useMemo(() => {
    const opts = {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
      skipPreflight: false,
    };
    return publicKey && signTransaction
      ? new AnchorProvider(connectionMemo, { publicKey, signTransaction }, opts)
      : new AnchorProvider(connectionMemo, {}, opts);
  }, [connectionMemo, publicKey, signTransaction]);

  const program = useMemo(() => {
    const prog = new Program(idl, programID, provider);
    console.log(`Program initialized with ID: ${programID.toBase58()}, IDL version: ${idl.version}`);
    return prog;
  }, [provider]);

  // Fetch SOLCIAL token balance
  useEffect(() => {
    if (!publicKey) {
      setSolcialBalance(null);
      return;
    }
    const fetchSolcialBalance = async () => {
      try {
        const userSolcialAccount = await getAssociatedTokenAddress(SOLCIAL_MINT, publicKey);
        const accountInfo = await provider.connection.getAccountInfo(userSolcialAccount);
        if (!accountInfo) {
          setSolcialBalance(0);
          return;
        }
        const balanceInfo = await withRetry(() => provider.connection.getTokenAccountBalance(userSolcialAccount));
        setSolcialBalance(balanceInfo.value.uiAmount);
      } catch (err) {
        console.error('Error fetching SOLCIAL balance:', err);
        setSolcialBalance(0);
      }
    };
    fetchSolcialBalance();
  }, [publicKey, provider.connection]);

  // Derive Forum PDA
  useEffect(() => {
    const deriveForumPda = async () => {
      try {
        const [derivedForumPda, bump] = await PublicKey.findProgramAddress(
          [Buffer.from('forum')],
          programID
        );
        setForumPda(derivedForumPda);
        console.log('Derived Forum PDA:', derivedForumPda.toBase58(), 'Bump:', bump);
        const forumBalance = await provider.connection.getBalance(derivedForumPda);
        console.log('Forum PDA balance:', forumBalance / LAMPORTS_PER_SOL, 'SOL');
      } catch (err) {
        console.error('Error deriving Forum PDA:', err);
        setError(`Failed to derive Forum PDA: ${err.message}`);
      }
    };
    deriveForumPda();
  }, [programID, provider.connection]);

  // Terminal effect
  const [terminalText, setTerminalText] = useState('');
  const fullText = 'INITIALIZING SOCIAL SYSTEM...';

  useEffect(() => {
    let index = 0;
    const timer = setInterval(() => {
      setTerminalText(fullText.slice(0, index));
      index++;
      if (index > fullText.length) {
        clearInterval(timer);
      }
    }, 100);
    return () => clearInterval(timer);
  }, []);

  // Wallet connection status
  useEffect(() => {
    if (publicKey) {
      setConnectionStatus('connected');
    } else {
      setConnectionStatus('disconnected');
      setForum(null);
      setPosts([]);
      setReplies([]);
      setPostReports([]);
      setReplyReports([]);
      setError(null);
      setStarredPosts([]);
      setShowUserPosts(false);
      setSolcialBalance(null);
    }
  }, [publicKey]);

  // Data fetching
  useEffect(() => {
    if (!publicKey || isFetching || !forumPda) return;

    setIsFetching(true);
    const debounceTimeout = setTimeout(() => {
      const fetchForum = async () => {
        setLoading(true);
        try {
          const forumData = await withRetry(() => program.account.forum.fetch(forumPda));
          setForum({
            admin: forumData.admin.toBase58(),
            postCount: forumData.postCount.toNumber(),
            replyCount: forumData.replyCount.toNumber(),
            reportCount: forumData.reportCount.toNumber(),
            version: forumData.version.toNumber(),
          });
          setError(null);
        } catch (err) {
          console.error('Error fetching forum:', err);
          if (err.message.includes('Account does not exist')) {
            setError('Forum not initialized. Please click "Initialize Social" to set up the forum.');
          } else {
            setError(`Failed to load forum: ${err.message}`);
          }
        } finally {
          setLoading(false);
        }
      };

      const fetchPosts = async () => {
        setLoading(true);
        try {
          const postAccounts = await withRetry(() => program.account.post.all());
          const posts = postAccounts.map((account) => ({
            id: account.publicKey.toBase58(),
            author: account.account.author.toBase58(),
            content: account.account.content,
            rating: account.account.rating.toNumber(),
            timestamp: account.account.timestamp.toNumber(),
            postId: account.account.id.toNumber(),
            category: categorizePost(account.account.content),
            isReported: account.account.isReported,
            reportCount: account.account.reportCount.toNumber(),
          }));
          setPosts(posts);
          setError(null);
        } catch (err) {
          console.error('Error fetching posts:', err);
          setError(`Failed to load posts: ${err.message}`);
        } finally {
          setLoading(false);
        }
      };

      const fetchReplies = async () => {
        setLoading(true);
        try {
          const replyAccounts = await withRetry(() => program.account.reply.all());
          const replies = replyAccounts.map((account) => ({
            id: account.publicKey.toBase58(),
            author: account.account.author.toBase58(),
            content: account.account.content,
            rating: account.account.rating.toNumber(),
            timestamp: account.account.timestamp.toNumber(),
            postId: account.account.postId.toNumber(),
            replyId: account.account.id.toNumber(),
            isReported: account.account.isReported,
            reportCount: account.account.reportCount.toNumber(),
          }));
          setReplies(replies);
          setError(null);
        } catch (err) {
          console.error('Error fetching replies:', err);
          setError(`Failed to load replies: ${err.message}`);
        } finally {
          setLoading(false);
        }
      };

      const fetchReports = async () => {
        setLoading(true);
        try {
          const postReportAccounts = await withRetry(() => program.account.postReport.all());
          const postReports = postReportAccounts.map((account) => ({
            id: account.publicKey.toBase58(),
            reporter: account.account.reporter.toBase58(),
            postId: account.account.postId.toNumber(),
            reason: account.account.reason,
            timestamp: account.account.timestamp.toNumber(),
            reportId: account.account.id.toNumber(),
            isResolved: account.account.isResolved,
            resolutionTimestamp: account.account.resolutionTimestamp.toNumber(),
            adminAction: account.account.adminAction,
          }));
          setPostReports(postReports);

          const replyReportAccounts = await withRetry(() => program.account.replyReport.all());
          const replyReports = replyReportAccounts.map((account) => ({
            id: account.publicKey.toBase58(),
            reporter: account.account.reporter.toBase58(),
            replyId: account.account.replyId.toNumber(),
            reason: account.account.reason,
            timestamp: account.account.timestamp.toNumber(),
            reportId: account.account.id.toNumber(),
            isResolved: account.account.isResolved,
            resolutionTimestamp: account.account.resolutionTimestamp.toNumber(),
            adminAction: account.account.adminAction,
          }));
          setReplyReports(replyReports);
          setError(null);
        } catch (err) {
          console.error('Error fetching reports:', err);
          setError(`Failed to load reports: ${err.message}`);
        } finally {
          setLoading(false);
        }
      };

      Promise.all([fetchForum(), fetchPosts(), fetchReplies(), fetchReports()]).finally(() => {
        setIsFetching(false);
      });
    }, 1000);

    return () => clearTimeout(debounceTimeout);
  }, [publicKey, program, forumPda]);

  // Starred posts persistence
  useEffect(() => {
    if (publicKey) {
      const storedStarred = localStorage.getItem(`starred_posts_${publicKey.toBase58()}`);
      if (storedStarred) {
        setStarredPosts(JSON.parse(storedStarred));
      }
    }
  }, [publicKey]);

  useEffect(() => {
    if (publicKey && starredPosts.length > 0) {
      localStorage.setItem(`starred_posts_${publicKey.toBase58()}`, JSON.stringify(starredPosts));
    }
  }, [starredPosts, publicKey]);

  const toggleStarPost = (postId) => {
    setStarredPosts((prev) => {
      if (prev.includes(postId)) {
        return prev.filter((id) => id !== postId);
      } else {
        return [...prev, postId];
      }
    });
  };

  const filteredPosts = useMemo(() => {
    let filtered = posts;
    if (activeSection === 'Starred Posts') {
      filtered = filtered.filter((post) => starredPosts.includes(post.id));
    } else if (activeSection === 'My Posts') {
      filtered = filtered.filter((post) => post.author === publicKey?.toBase58());
    } else if (activeSection === 'Reported Posts') {
      filtered = filtered.filter((post) => post.isReported || post.reportCount > 0);
    } else if (activeSection !== 'All') {
      filtered = filtered.filter((post) => post.category === activeSection);
    }
    return filtered.sort((a, b) => b.timestamp - a.timestamp);
  }, [posts, activeSection, starredPosts, publicKey]);

  const categorizePost = (content) => {
    const lowerContent = content.toLowerCase();
    if (lowerContent.includes('meme launch') || lowerContent.includes('meme coin')) {
      return 'Meme Launches';
    } else if (lowerContent.includes('solana gem') || lowerContent.includes('hidden gem')) {
      return 'Solana Gems';
    } else if (lowerContent.includes('politics') || lowerContent.includes('election')) {
      return 'Politics';
    } else if (lowerContent.includes('dev help') || lowerContent.includes('coding')) {
      return 'Dev Help';
    } else if (lowerContent.includes('announcement') || lowerContent.includes('update')) {
      return 'Announcements';
    } else if (lowerContent.includes('solana dapp') || lowerContent.includes('new dapp')) {
      return 'New Solana Dapps';
    } else if (lowerContent.includes('solcial')) {
      return 'Solcial Discussion';
    } else {
      return 'General Chatting';
    }
  };

  const executeTransactionSilently = async (transactionFn, successMessage = "Transaction completed") => {
    setLoading(true);
    setError(null);

    let transactionAttempted = false;
    try {
      await transactionFn();
      transactionAttempted = true;
      console.log(successMessage);
    } catch (err) {
      console.error('Transaction error caught:', err.message, 'Stack:', err.stack);
      console.log('Ignoring error and refreshing data...');
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`Refreshing data (attempt ${attempt})...`);
        if (forumPda) {
          const forumData = await withRetry(() => program.account.forum.fetch(forumPda));
          setForum({
            admin: forumData.admin.toBase58(),
            postCount: forumData.postCount.toNumber(),
            replyCount: forumData.replyCount.toNumber(),
            reportCount: forumData.reportCount.toNumber(),
            version: forumData.version.toNumber(),
          });
        }
        const postAccounts = await withRetry(() => program.account.post.all());
        const newPosts = postAccounts.map((account) => ({
          id: account.publicKey.toBase58(),
          author: account.account.author.toBase58(),
          content: account.account.content,
          rating: account.account.rating.toNumber(),
          timestamp: account.account.timestamp.toNumber(),
          postId: account.account.id.toNumber(),
          category: categorizePost(account.account.content),
          isReported: account.account.isReported,
          reportCount: account.account.reportCount.toNumber(),
        }));
        setPosts(newPosts);
        const replyAccounts = await withRetry(() => program.account.reply.all());
        const newReplies = replyAccounts.map((account) => ({
          id: account.publicKey.toBase58(),
          author: account.account.author.toBase58(),
          content: account.account.content,
          rating: account.account.rating.toNumber(),
          timestamp: account.account.timestamp.toNumber(),
          postId: account.account.postId.toNumber(),
          replyId: account.account.id.toNumber(),
          isReported: account.account.isReported,
          reportCount: account.account.reportCount.toNumber(),
        }));
        setReplies(newReplies);
        const postReportAccounts = await withRetry(() => program.account.postReport.all());
        const newPostReports = postReportAccounts.map((account) => ({
          id: account.publicKey.toBase58(),
          reporter: account.account.reporter.toBase58(),
          postId: account.account.postId.toNumber(),
          reason: account.account.reason,
          timestamp: account.account.timestamp.toNumber(),
          reportId: account.account.id.toNumber(),
          isResolved: account.account.isResolved,
          resolutionTimestamp: account.account.resolutionTimestamp.toNumber(),
          adminAction: account.account.adminAction,
        }));
        setPostReports(newPostReports);
        const replyReportAccounts = await withRetry(() => program.account.replyReport.all());
        const newReplyReports = replyReportAccounts.map((account) => ({
          id: account.publicKey.toBase58(),
          reporter: account.account.reporter.toBase58(),
          replyId: account.account.replyId.toNumber(),
          reason: account.account.reason,
          timestamp: account.account.timestamp.toNumber(),
          reportId: account.account.id.toNumber(),
          isResolved: account.account.isResolved,
          resolutionTimestamp: account.account.resolutionTimestamp.toNumber(),
          adminAction: account.account.adminAction,
        }));
        setReplyReports(newReplyReports);
        console.log('Data refreshed successfully:', {
          forum: forumPda ? forum : null,
          postCount: newPosts.length,
          replyCount: newReplies.length,
          postReportCount: newPostReports.length,
          replyReportCount: newReplyReports.length,
        });
        break;
      } catch (refreshErr) {
        console.warn(`Data refresh failed (attempt ${attempt}):`, refreshErr.message);
        if (attempt === 3) {
          console.error('All refresh attempts failed');
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    setLoading(false);
  };

  const initializeForum = async () => {
    if (!publicKey) {
      setError('Please connect your wallet.');
      return;
    }

    if (!forumPda) {
      setError('Forum PDA not yet derived. Please wait a moment and try again.');
      return;
    }

    if (!MODERATOR_PUBLIC_KEYS.concat([ADMIN_PUBLIC_KEY]).some(key => key.toBase58() === publicKey.toBase58())) {
      setError(`Only admins (${MODERATOR_PUBLIC_KEYS.concat([ADMIN_PUBLIC_KEY]).map(key => key.toBase58().slice(0, 8)).join(', ')}...) can initialize the forum.`);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const walletBalance = await withRetry(() => provider.connection.getBalance(publicKey));
      const rentExemption = await withRetry(() => provider.connection.getMinimumBalanceForRentExemption(512));
      if (walletBalance < rentExemption + LAMPORTS_PER_SOL * 0.01) {
        setError(`Insufficient wallet balance. Need ~${((rentExemption + LAMPORTS_PER_SOL * 0.01) / LAMPORTS_PER_SOL).toFixed(4)} SOL for initialization.`);
        return;
      }

      const forumAccountInfo = await withRetry(() => provider.connection.getAccountInfo(forumPda));
      if (forumAccountInfo) {
        try {
          const forumData = await withRetry(() => program.account.forum.fetch(forumPda));
          if (MODERATOR_PUBLIC_KEYS.concat([ADMIN_PUBLIC_KEY]).some(key => key.toBase58() === forumData.admin.toBase58())) {
            setError('Forum is already initialized with a valid admin. No action needed.');
            setForum({
              admin: forumData.admin.toBase58(),
              postCount: forumData.postCount.toNumber(),
              replyCount: forumData.replyCount.toNumber(),
              reportCount: forumData.reportCount.toNumber(),
              version: forumData.version.toNumber(),
            });
            return;
          } else {
            setError(`Forum is already initialized with a different admin (${forumData.admin.toBase58().slice(0, 8)}...). Cannot reinitialize. Please close the existing forum account or use a different program ID.`);
            return;
          }
        } catch (fetchErr) {
          console.error('Error fetching existing forum data:', fetchErr);
          setError('Forum account exists but cannot be read. It may be corrupted or initialized incorrectly. Try closing the account or using a different program ID.');
          return;
        }
      }

      const forumBalance = await withRetry(() => provider.connection.getBalance(forumPda));
      if (forumBalance < rentExemption) {
        const fundTx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: publicKey,
            toPubkey: forumPda,
            lamports: rentExemption + LAMPORTS_PER_SOL * 0.01,
          })
        );
        const fundSignature = await sendAndConfirmWithRetry(provider, fundTx);
        console.log('Forum PDA funded, signature:', fundSignature);
      }

      const transaction = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: 600000,
        }),
        await program.methods
          .initializeForum()
          .accounts({
            forum: forumPda,
            admin: publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction()
      );

      const signature = await sendAndConfirmWithRetry(provider, transaction);
      console.log('Forum initialized, signature:', signature);

      const forumData = await withRetry(() => program.account.forum.fetch(forumPda));
      setForum({
        admin: forumData.admin.toBase58(),
        postCount: forumData.postCount.toNumber(),
        replyCount: forumData.replyCount.toNumber(),
        reportCount: forumData.reportCount.toNumber(),
        version: forumData.version.toNumber(),
      });
      setError(null);
    } catch (err) {
      console.error('Error initializing forum:', err);
      setError(`Failed to initialize forum: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const createPost = async () => {
    if (!publicKey || !newPostContent || !forumPda) {
      setError('Please connect wallet, enter post content, and wait for Forum PDA to be derived.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }
    if (newPostCategory === 'Announcements' && 
        !MODERATOR_PUBLIC_KEYS.some(mod => mod.toBase58() === publicKey.toBase58()) && 
        publicKey.toBase58() !== ADMIN_PUBLIC_KEY.toBase58()) {
      setError('Only admins and moderators can post in Announcements.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }
    const categorizedContent = `[${newPostCategory}] ${newPostContent}`;
    if (categorizedContent.length > 280) {
      setError('Post content exceeds 280 characters. Please shorten it.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }
    if (!categorizedContent.trim()) {
      setError('Post content cannot be empty.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }

    await executeTransactionSilently(async () => {
      const feeRecipient = POST_FEE_RECIPIENT;
      const forumData = await withRetry(() => program.account.forum.fetch(forumPda));
      const postCount = forumData.postCount.toNumber();
      const [postPda] = await PublicKey.findProgramAddress(
        [Buffer.from('post'), forumPda.toBuffer(), Buffer.from(new BN(postCount).toArray('le', 8))],
        programID
      );

      let transaction;
      if (useSolcial) {
        if (solcialBalance < SOLCIAL_POST_FEE) {
          throw new Error(`Insufficient SOLCIAL tokens. Need ${SOLCIAL_POST_FEE} SOLCIAL, have ${solcialBalance}.`);
        }
        const userSolcialAccount = await getAssociatedTokenAddress(SOLCIAL_MINT, publicKey);
        const solcialRecipientAccount = await getAssociatedTokenAddress(SOLCIAL_MINT, SOLCIAL_RECIPIENT);
        transaction = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 500000 })
        );
        transaction.add(
          await program.methods
            .createPostWithSolcial(categorizedContent)
            .accounts({
              post: postPda,
              forum: forumPda,
              user: publicKey,
              userSolcialAccount,
              solcialRecipient: solcialRecipientAccount,
              solcialMint: SOLCIAL_MINT,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .instruction()
        );
      } else {
        const feeRecipientInfo = await withRetry(() => provider.connection.getAccountInfo(feeRecipient));
        if (!feeRecipientInfo) {
          throw new Error(`Fee recipient account (${feeRecipient.toBase58().slice(0, 8)}...) does not exist.`);
        }
        const walletBalance = await withRetry(() => provider.connection.getBalance(publicKey));
        if (walletBalance < POST_FEE * LAMPORTS_PER_SOL) {
          throw new Error(`Insufficient SOL. Need ${POST_FEE} SOL, have ${walletBalance / LAMPORTS_PER_SOL} SOL.`);
        }
        transaction = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 500000 })
        );
        transaction.add(
          await program.methods
            .createPost(categorizedContent)
            .accounts({
              post: postPda,
              forum: forumPda,
              user: publicKey,
              feeRecipient,
              systemProgram: SystemProgram.programId,
            })
            .instruction()
        );
      }

      const signature = await sendAndConfirmWithRetry(provider, transaction);
      console.log('Post created, signature:', signature);
      setNewPostContent('');
      setShowCreatePost(false);
      setNewPostCategory('General Chatting');
    }, "Post created successfully");
  };

  const createReply = async (postId) => {
    if (!publicKey || !newReplyContent[postId] || !forumPda) {
      setError('Please connect wallet, enter reply content, and wait for Forum PDA to be derived.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }
    const post = posts.find((p) => p.id === postId);
    if (!post) {
      setError('Post not found. Please ensure the post exists.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }
    if (newReplyContent[postId].length > 280) {
      setError('Reply content exceeds 280 characters. Please shorten it.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }
    if (!newReplyContent[postId].trim()) {
      setError('Reply content cannot be empty.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }

    await executeTransactionSilently(async () => {
      const forumData = await withRetry(() => program.account.forum.fetch(forumPda));
      const replyCount = forumData.replyCount.toNumber();
      const [postPublicKey] = await PublicKey.findProgramAddress(
        [Buffer.from('post'), forumPda.toBuffer(), Buffer.from(new BN(post.postId).toArray('le', 8))],
        programID
      );
      const [replyPda] = await PublicKey.findProgramAddress(
        [Buffer.from('reply'), forumPda.toBuffer(), Buffer.from(new BN(replyCount).toArray('le', 8))],
        programID
      );

      let transaction;
      if (useSolcial) {
        if (solcialBalance < SOLCIAL_REPLY_FEE) {
          throw new Error(`Insufficient SOLCIAL tokens. Need ${SOLCIAL_REPLY_FEE} SOLCIAL, have ${solcialBalance}.`);
        }
        const userSolcialAccount = await getAssociatedTokenAddress(SOLCIAL_MINT, publicKey);
        const postAuthorSolcialAccount = await getAssociatedTokenAddress(SOLCIAL_MINT, new PublicKey(post.author));
        transaction = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 })
        );
        transaction.add(
          await program.methods
            .createReplyWithSolcial(newReplyContent[postId])
            .accounts({
              reply: replyPda,
              forum: forumPda,
              post: postPublicKey,
              user: publicKey,
              userSolcialAccount,
              postAuthorSolcialAccount,
              solcialMint: SOLCIAL_MINT,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .instruction()
        );
      } else {
        const walletBalance = await withRetry(() => provider.connection.getBalance(publicKey));
        if (walletBalance < REPLY_FEE * LAMPORTS_PER_SOL) {
          throw new Error(`Insufficient SOL. Need ${REPLY_FEE} SOL, have ${walletBalance / LAMPORTS_PER_SOL} SOL.`);
        }
        const postAuthorPublicKey = new PublicKey(post.author);
        transaction = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 })
        );
        transaction.add(
          await program.methods
            .createReply(newReplyContent[postId])
            .accounts({
              reply: replyPda,
              forum: forumPda,
              post: postPublicKey,
              user: publicKey,
              postAuthor: postAuthorPublicKey,
              systemProgram: SystemProgram.programId,
            })
            .instruction()
        );
      }

      const signature = await sendAndConfirmWithRetry(provider, transaction);
      console.log('Reply created, signature:', signature);
      setNewReplyContent((prev) => ({ ...prev, [postId]: '' }));
      setShowReplyForm((prev) => ({ ...prev, [postId]: false }));
    }, "Reply created successfully");
  };

  const ratePost = async (postId, isUpvote) => {
    if (!publicKey || !forumPda) {
      setError('Please connect wallet and wait for Forum PDA to be derived.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }
    const post = posts.find((p) => p.id === postId);
    if (!post) {
      setError('Post not found. Please ensure the post exists.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }

    await executeTransactionSilently(async () => {
      const postPublicKey = new PublicKey(postId);
      const [userRatingPda] = await PublicKey.findProgramAddress(
        [Buffer.from('rating'), postPublicKey.toBuffer(), publicKey.toBuffer()],
        programID
      );

      let transaction;
      if (useSolcial) {
        if (solcialBalance < SOLCIAL_VOTE_FEE) {
          throw new Error(`Insufficient SOLCIAL tokens. Need ${SOLCIAL_VOTE_FEE} SOLCIAL, have ${solcialBalance}.`);
        }
        const userSolcialAccount = await getAssociatedTokenAddress(SOLCIAL_MINT, publicKey);
        const postAuthorSolcialAccount = await getAssociatedTokenAddress(SOLCIAL_MINT, new PublicKey(post.author));
        const solcialRecipientAccount = await getAssociatedTokenAddress(SOLCIAL_MINT, SOLCIAL_RECIPIENT);
        transaction = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 })
        );
        transaction.add(
          await program.methods
            .ratePostWithSolcial(isUpvote)
            .accounts({
              post: postPublicKey,
              userRating: userRatingPda,
              user: publicKey,
              forum: forumPda,
              userSolcialAccount,
              postAuthorSolcialAccount,
              solcialRecipient: solcialRecipientAccount,
              solcialMint: SOLCIAL_MINT,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .instruction()
        );
      } else {
        const walletBalance = await withRetry(() => provider.connection.getBalance(publicKey));
        if (walletBalance < VOTE_FEE * LAMPORTS_PER_SOL) {
          throw new Error(`Insufficient SOL. Need ${VOTE_FEE} SOL, have ${walletBalance / LAMPORTS_PER_SOL} SOL.`);
        }
        const postAuthorPublicKey = new PublicKey(post.author);
        transaction = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 })
        );
        transaction.add(
          await program.methods
            .ratePost(isUpvote)
            .accounts({
              post: postPublicKey,
              userRating: userRatingPda,
              user: publicKey,
              forum: forumPda,
              postAuthor: postAuthorPublicKey,
              systemProgram: SystemProgram.programId,
            })
            .instruction()
        );
      }

      const signature = await sendAndConfirmWithRetry(provider, transaction);
      console.log('Post rated, signature:', signature);
    }, `Post ${isUpvote ? 'upvoted' : 'downvoted'} successfully`);
  };

  const rateReply = async (replyId, isUpvote) => {
    if (!publicKey || !forumPda) {
      setError('Please connect wallet and wait for Forum PDA to be derived.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }
    const reply = replies.find((r) => r.id === replyId);
    if (!reply) {
      setError('Reply not found. Please ensure the reply exists.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }

    await executeTransactionSilently(async () => {
      const replyPublicKey = new PublicKey(replyId);
      const [userRatingPda] = await PublicKey.findProgramAddress(
        [Buffer.from('rating'), replyPublicKey.toBuffer(), publicKey.toBuffer()],
        programID
      );
      const post = posts.find((p) => p.postId === reply.postId);
      if (!post) {
        throw new Error('Associated post not found.');
      }
      const postPublicKey = new PublicKey(post.id);

      let transaction;
      if (useSolcial) {
        if (solcialBalance < SOLCIAL_VOTE_FEE) {
          throw new Error(`Insufficient SOLCIAL tokens. Need ${SOLCIAL_VOTE_FEE} SOLCIAL, have ${solcialBalance}.`);
        }
        const userSolcialAccount = await getAssociatedTokenAddress(SOLCIAL_MINT, publicKey);
        const replyAuthorSolcialAccount = await getAssociatedTokenAddress(SOLCIAL_MINT, new PublicKey(reply.author));
        const solcialRecipientAccount = await getAssociatedTokenAddress(SOLCIAL_MINT, SOLCIAL_RECIPIENT);
        transaction = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 })
        );
        transaction.add(
          await program.methods
            .rateReplyWithSolcial(isUpvote)
            .accounts({
              reply: replyPublicKey,
              userRating: userRatingPda,
              user: publicKey,
              forum: forumPda,
              post: postPublicKey,
              userSolcialAccount,
              postAuthorSolcialAccount: replyAuthorSolcialAccount,
              solcialRecipient: solcialRecipientAccount,
              solcialMint: SOLCIAL_MINT,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .instruction()
        );
      } else {
        const walletBalance = await withRetry(() => provider.connection.getBalance(publicKey));
        if (walletBalance < VOTE_FEE * LAMPORTS_PER_SOL) {
          throw new Error(`Insufficient SOL. Need ${VOTE_FEE} SOL, have ${walletBalance / LAMPORTS_PER_SOL} SOL.`);
        }
        const replyAuthorPublicKey = new PublicKey(reply.author);
        transaction = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 })
        );
        transaction.add(
          await program.methods
            .rateReply(isUpvote)
            .accounts({
              reply: replyPublicKey,
              userRating: userRatingPda,
              user: publicKey,
              forum: forumPda,
              post: postPublicKey,
              postAuthor: replyAuthorPublicKey,
              systemProgram: SystemProgram.programId,
            })
            .instruction()
        );
      }

      const signature = await sendAndConfirmWithRetry(provider, transaction);
      console.log('Reply rated, signature:', signature);
    }, `Reply ${isUpvote ? 'upvoted' : 'downvoted'} successfully`);
  };

  const reportPost = async (postId) => {
    if (!publicKey || !forumPda || !reportReason) {
      setError('Please connect wallet, wait for Forum PDA to be derived, and provide a report reason.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }
    const post = posts.find((p) => p.id === postId);
    if (!post) {
      setError('Post not found. Please ensure the post exists.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }
    if (reportReason.length > 100) {
      setError('Report reason exceeds 100 characters. Please shorten it.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }
    if (!reportReason.trim()) {
      setError('Report reason cannot be empty.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }

    await executeTransactionSilently(async () => {
      const forumData = await withRetry(() => program.account.forum.fetch(forumPda));
      const reportCount = forumData.reportCount.toNumber();
      const postPublicKey = new PublicKey(postId);
      const [reportPda] = await PublicKey.findProgramAddress(
        [Buffer.from('report'), forumPda.toBuffer(), Buffer.from(new BN(reportCount).toArray('le', 8))],
        programID
      );

      let transaction;
      if (useSolcial) {
        if (solcialBalance < SOLCIAL_REPORT_FEE) {
          throw new Error(`Insufficient SOLCIAL tokens. Need ${SOLCIAL_REPORT_FEE} SOLCIAL, have ${solcialBalance}.`);
        }
        const userSolcialAccount = await getAssociatedTokenAddress(SOLCIAL_MINT, publicKey);
        const solcialRecipientAccount = await getAssociatedTokenAddress(SOLCIAL_MINT, SOLCIAL_RECIPIENT);
        transaction = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 })
        );
        transaction.add(
          await program.methods
            .reportPostWithSolcial(reportReason)
            .accounts({
              report: reportPda,
              post: postPublicKey,
              forum: forumPda,
              user: publicKey,
              userSolcialAccount,
              solcialRecipient: solcialRecipientAccount,
              solcialMint: SOLCIAL_MINT,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .instruction()
        );
      } else {
        const walletBalance = await withRetry(() => provider.connection.getBalance(publicKey));
        if (walletBalance < REPORT_FEE * LAMPORTS_PER_SOL) {
          throw new Error(`Insufficient SOL. Need ${REPORT_FEE} SOL, have ${walletBalance / LAMPORTS_PER_SOL} SOL.`);
        }
        transaction = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 })
        );
        transaction.add(
          await program.methods
            .reportPost(reportReason)
            .accounts({
              report: reportPda,
              post: postPublicKey,
              forum: forumPda,
              user: publicKey,
              feeRecipient: POST_FEE_RECIPIENT,
              systemProgram: SystemProgram.programId,
            })
            .instruction()
        );
      }

      const signature = await sendAndConfirmWithRetry(provider, transaction);
      console.log('Post reported, signature:', signature);
      setShowReportModal({ show: false, type: null, id: null });
      setReportReason('');
    }, "Post reported successfully");
  };

  const reportReply = async (replyId) => {
    if (!publicKey || !forumPda || !reportReason) {
      setError('Please connect wallet, wait for Forum PDA to be derived, and provide a report reason.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }
    const reply = replies.find((r) => r.id === replyId);
    if (!reply) {
      setError('Reply not found. Please ensure the reply exists.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }
    if (reportReason.length > 100) {
      setError('Report reason exceeds 100 characters. Please shorten it.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }
    if (!reportReason.trim()) {
      setError('Report reason cannot be empty.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }

    await executeTransactionSilently(async () => {
      const forumData = await withRetry(() => program.account.forum.fetch(forumPda));
      const reportCount = forumData.reportCount.toNumber();
      const replyPublicKey = new PublicKey(replyId);
      const [reportPda] = await PublicKey.findProgramAddress(
        [Buffer.from('report'), forumPda.toBuffer(), Buffer.from(new BN(reportCount).toArray('le', 8))],
        programID
      );

      let transaction;
      if (useSolcial) {
        if (solcialBalance < SOLCIAL_REPORT_FEE) {
          throw new Error(`Insufficient SOLCIAL tokens. Need ${SOLCIAL_REPORT_FEE} SOLCIAL, have ${solcialBalance}.`);
        }
        const userSolcialAccount = await getAssociatedTokenAddress(SOLCIAL_MINT, publicKey);
        const solcialRecipientAccount = await getAssociatedTokenAddress(SOLCIAL_MINT, SOLCIAL_RECIPIENT);
        transaction = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 })
        );
        transaction.add(
          await program.methods
            .reportReplyWithSolcial(reportReason)
            .accounts({
              report: reportPda,
              reply: replyPublicKey,
              forum: forumPda,
              user: publicKey,
              userSolcialAccount,
              solcialRecipient: solcialRecipientAccount,
              solcialMint: SOLCIAL_MINT,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .instruction()
        );
      } else {
        const walletBalance = await withRetry(() => provider.connection.getBalance(publicKey));
        if (walletBalance < REPORT_FEE * LAMPORTS_PER_SOL) {
          throw new Error(`Insufficient SOL. Need ${REPORT_FEE} SOL, have ${walletBalance / LAMPORTS_PER_SOL} SOL.`);
        }
        transaction = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 })
        );
        transaction.add(
          await program.methods
            .reportReply(reportReason)
            .accounts({
              report: reportPda,
              reply: replyPublicKey,
              forum: forumPda,
              user: publicKey,
              feeRecipient: POST_FEE_RECIPIENT,
              systemProgram: SystemProgram.programId,
            })
            .instruction()
        );
      }

      const signature = await sendAndConfirmWithRetry(provider, transaction);
      console.log('Reply reported, signature:', signature);
      setShowReportModal({ show: false, type: null, id: null });
      setReportReason('');
    }, "Reply reported successfully");
  };

  const resolveReport = async (reportId, actionTaken, isPostReport) => {
    if (!publicKey || !forumPda) {
      setError('Please connect wallet and wait for Forum PDA to be derived.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }
    if (!MODERATOR_PUBLIC_KEYS.some(mod => mod.toBase58() === publicKey.toBase58()) && 
        publicKey.toBase58() !== ADMIN_PUBLIC_KEY.toBase58()) {
      setError('Only admins and moderators can resolve reports.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }
    if (!actionTaken || actionTaken.length > 100) {
      setError('Action taken must be provided and not exceed 100 characters.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }

    await executeTransactionSilently(async () => {
      const reportPublicKey = new PublicKey(reportId);
      const transaction = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 })
      );
      transaction.add(
        await program.methods
          [isPostReport ? 'resolveReport' : 'resolveReplyReport'](actionTaken)
          .accounts({
            report: reportPublicKey,
            forum: forumPda,
            admin: publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction()
      );

      const signature = await sendAndConfirmWithRetry(provider, transaction);
      console.log(`${isPostReport ? 'Post' : 'Reply'} report resolved, signature:`, signature);
    }, `${isPostReport ? 'Post' : 'Reply'} report resolved successfully`);
  };

  const deletePost = async (postId) => {
    if (!publicKey || !forumPda) {
      setError('Please connect wallet and wait for Forum PDA to be derived.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }
    if (!MODERATOR_PUBLIC_KEYS.some(mod => mod.toBase58() === publicKey.toBase58()) && 
        publicKey.toBase58() !== ADMIN_PUBLIC_KEY.toBase58()) {
      setError('Only admins and moderators can delete posts.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }

    await executeTransactionSilently(async () => {
      const postPublicKey = new PublicKey(postId);
      const transaction = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 })
      );
      transaction.add(
        await program.methods
          .deletePost()
          .accounts({
            post: postPublicKey,
            forum: forumPda,
            admin: publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction()
      );

      const signature = await sendAndConfirmWithRetry(provider, transaction);
      console.log('Post deleted, signature:', signature);
    }, "Post deleted successfully");
  };

  const deleteReply = async (replyId) => {
    if (!publicKey || !forumPda) {
      setError('Please connect wallet and wait for Forum PDA to be derived.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }
    if (!MODERATOR_PUBLIC_KEYS.some(mod => mod.toBase58() === publicKey.toBase58()) && 
        publicKey.toBase58() !== ADMIN_PUBLIC_KEY.toBase58()) {
      setError('Only admins and moderators can delete replies.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }

    await executeTransactionSilently(async () => {
      const replyPublicKey = new PublicKey(replyId);
      const transaction = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 })
      );
      transaction.add(
        await program.methods
          .deleteReply()
          .accounts({
            reply: replyPublicKey,
            forum: forumPda,
            admin: publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction()
      );

      const signature = await sendAndConfirmWithRetry(provider, transaction);
      console.log('Reply deleted, signature:', signature);
    }, "Reply deleted successfully");
  };

  const closeReport = async (reportId, isPostReport) => {
    if (!publicKey || !forumPda) {
      setError('Please connect wallet and wait for Forum PDA to be derived.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }
    if (!MODERATOR_PUBLIC_KEYS.some(mod => mod.toBase58() === publicKey.toBase58()) && 
        publicKey.toBase58() !== ADMIN_PUBLIC_KEY.toBase58()) {
      setError('Only admins and moderators can close reports.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }

    await executeTransactionSilently(async () => {
      const reportPublicKey = new PublicKey(reportId);
      const transaction = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 })
      );
      transaction.add(
        await program.methods
          [isPostReport ? 'closePostReport' : 'closeReplyReport']()
          .accounts({
            report: reportPublicKey,
            admin: publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction()
      );

      const signature = await sendAndConfirmWithRetry(provider, transaction);
      console.log(`${isPostReport ? 'Post' : 'Reply'} report closed, signature:`, signature);
    }, `${isPostReport ? 'Post' : 'Reply'} report closed successfully`);
  };

  const closeForum = async () => {
    if (!publicKey || !forumPda) {
      setError('Please connect wallet and wait for Forum PDA to be derived.');
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }
    if (publicKey.toBase58() !== ADMIN_PUBLIC_KEY.toBase58()) {
      setError(`Only admin (${ADMIN_PUBLIC_KEY.toBase58().slice(0, 8)}...) can close the forum.`);
      await executeTransactionSilently(async () => {}, 'Validation failed, refreshing data...');
      return;
    }

    await executeTransactionSilently(async () => {
      const transaction = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 })
      );
      transaction.add(
        await program.methods
          .closeForum()
          .accounts({
            forum: forumPda,
            admin: publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction()
      );

      const signature = await sendAndConfirmWithRetry(provider, transaction);
      console.log('Forum closed, signature:', signature);
      setForum(null);
      setPosts([]);
      setReplies([]);
      setPostReports([]);
      setReplyReports([]);
    }, "Forum closed successfully");
  };

const connectEvmWallet = async () => {
  if (!window.ethereum) {
    setError('MetaMask not detected. Install MetaMask or use a compatible EVM wallet.');
    return;
  }

  try {
    const provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    const signer = await provider.getSigner();
    const address = await signer.getAddress();

    const network = await provider.getNetwork();
    const currentChainId = Number(network.chainId);
    const targetChainId = selectedInput.chain;

    if (currentChainId !== targetChainId) {
      try {
        // Attempt switch
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: `0x${targetChainId.toString(16)}` }],
        });
      } catch (switchError) {
        if (switchError.code === 4902) {
          // Chain not added, add it
          const chainParams = getChainParams(targetChainId);
          if (!chainParams) {
            throw new Error(`Unsupported chain: ${targetChainId}`);
          }
          
          try {
            await window.ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [chainParams],
            });
          } catch (addError) {
            throw new Error(`Failed to add chain: ${addError.message}`);
          }
        } else if (switchError.code === 4001) {
          throw new Error('Chain switch rejected. Please approve in MetaMask.');
        } else {
          throw new Error(`Chain switch failed: ${switchError.message}`);
        }
      }
    }

    setEvmProvider(provider);
    setEvmAddress(address);
    console.log('✅ EVM wallet connected:', address, 'on chain:', targetChainId);
    
  } catch (err) {
    setError(`MetaMask connection failed: ${err.message}`);
    console.error('EVM connection error:', err);
  }
};

// Helper function
const getChainParams = (chainId) => {
  const chains = {
    56: {
      chainId: '0x38',
      chainName: 'BNB Smart Chain',
      nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
      rpcUrls: ['https://bsc-dataseed.binance.org/', 'https://bsc-dataseed1.defibit.io/'],
      blockExplorerUrls: ['https://bscscan.com'],
    },
    1: {
      chainId: '0x1',
      chainName: 'Ethereum Mainnet',
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://eth.public-rpc.com/'],
      blockExplorerUrls: ['https://etherscan.io'],
    },
  };
  return chains[chainId] || null;
};

  const getPrice = async (id) => {
    try {
      const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
      if (!res.ok) throw new Error('CoinGecko API failed');
      const data = await res.json();
      return data[id].usd;
    } catch (err) {
      console.error('CoinGecko price fetch failed:', err);
      try {
        let symbol;
        if (id === 'ethereum') symbol = 'ETHUSDT';
        else if (id === 'solana') symbol = 'SOLUSDT';
        else if (id === 'binancecoin') symbol = 'BNBUSDT';
        else throw new Error('Unsupported asset for Binance fallback');
        const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
        if (!res.ok) throw new Error('Binance API failed');
        const data = await res.json();
        return parseFloat(data.price);
      } catch (binanceErr) {
        console.error('Binance price fetch failed:', binanceErr);
        throw new Error('Failed to get price from both CoinGecko and Binance');
      }
    }
  };

  const estimateBridge = async () => {
    setLoading(true);
    setError(null);
  
    // Use BASE_BRIDGE_AMOUNT (0.012 SOL) + POST_FEE (0.001 SOL) = 0.013 SOL total
    const totalRequiredSol = BASE_BRIDGE_AMOUNT + POST_FEE; // 0.013 SOL
    const decimals = SOL_DECIMALS;
    const dstToken = SOL_MINT;
    const dstAmount = Math.floor(totalRequiredSol * 10 ** decimals).toString();
  
    try {
      const url = new URL(`${DEBRIDGE_API_BASE}/order/create-tx`);
      url.searchParams.append('srcChainId', selectedInput.chain);
      url.searchParams.append('dstChainId', 7565164);
      url.searchParams.append('srcChainTokenIn', selectedInput.token);
      url.searchParams.append('dstChainTokenOut', dstToken);
      url.searchParams.append('srcChainTokenInAmount', 'auto');
      url.searchParams.append('dstChainTokenOutAmount', dstAmount);
      url.searchParams.append('prependOperatingExpense', 'true');
      url.searchParams.append('affiliateFeePercent', AFFILIATE_PERCENT);
      url.searchParams.append('affiliateFeeRecipient', AFFILIATE_RECIPIENT);

      const response = await fetch(url.toString());
      if (!response.ok) throw new Error('DeBridge API estimation failed');
      const data = await response.json();
      
      setEstimationInfo(data.estimation);
      setBridgeAmount(ethers.formatUnits(data.estimation.srcChainTokenIn.amount, selectedInput.decimals));
      
      console.log(`Bridge estimation complete:`);
      console.log(`- Total SOL received: ${totalRequiredSol} SOL`);
      console.log(`- Base bridge: ${BASE_BRIDGE_AMOUNT} SOL`);
      console.log(`- Post fee: ${POST_FEE} SOL`);
      console.log(`- Input required: ${bridgeAmount} ${selectedInput.label.split(' on')[0]}`);
      
    } catch (err) {
      console.warn('DeBridge API failed, falling back to oracle estimation:', err.message);
      try {
        // Fallback to oracle
        const srcId = selectedInput.coingeckoId;
        const srcPrice = await getPrice(srcId);
        const dstPrice = await getPrice('solana');
        const requiredUsd = totalRequiredSol * dstPrice;
        let requiredInput = requiredUsd / srcPrice;
        const buffer = 1.03; // 3% buffer for bridge fees + volatility
        requiredInput *= buffer;
	const requiredSatoshis = Math.ceil(requiredInput * buffer * (10 ** selectedInput.decimals));
        const finalAmount = (requiredSatoshis / (10 ** selectedInput.decimals)).toFixed(selectedInput.decimals);
        setBridgeAmount(finalAmount);
        
        setBridgeAmount(requiredInput.toFixed(9));
        setEstimationInfo({ 
          dstChainTokenOut: { 
            amount: dstAmount,
            token: dstToken 
          },
          srcChainTokenIn: { 
            amount: ethers.parseUnits(requiredInput.toFixed(9), selectedInput.decimals).toString()
          }
        });
        
        console.log(`Oracle estimation complete:`);
        console.log(`- Total SOL received: ${totalRequiredSol} SOL`);
        console.log(`- Input required: ${requiredInput.toFixed(9)} ${selectedInput.label.split(' on')[0]}`);
        
      } catch (oracleErr) {
        setError(`Estimation failed: ${oracleErr.message}`);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleBridgeAndPost = async () => {
    // DEBUG LOGGING
    console.log('🔍 Bridge Debug State:', {
      evmProvider: !!evmProvider,
      evmAddress,
      publicKey: !!publicKey,
      estimationInfo: !!estimationInfo,
      bridgePostContent: bridgePostContent.trim(),
      selectedInput: selectedInput?.label
    });

    if (!evmProvider || !evmAddress || !publicKey || !estimationInfo || !bridgePostContent.trim()) {
      const missing = [];
      if (!evmProvider) missing.push('MetaMask Provider');
      if (!evmAddress) missing.push('MetaMask Address');
      if (!publicKey) missing.push('Solana Wallet');
      if (!estimationInfo) missing.push('Bridge Estimation');
      if (!bridgePostContent.trim()) missing.push('Post Content');
      
      setError(`Missing: ${missing.join(', ')}`);
      return;
    }

  if (!evmProvider || !evmAddress || !publicKey || !estimationInfo || !bridgePostContent.trim()) {
    setError('Connect MetaMask, enter post content, and estimate first');
    return;
  }

  setLoading(true);
  setError(null);

  try {
    // Bridge configuration
    const BRIDGE_AMOUNTS = {
      1: 0.0073,    // ETH
      56: 0.027     // BNB
    };

    const bridgeSolAmount = BRIDGE_AMOUNTS[selectedInput.chain];
    const postFeeSol = POST_FEE;
    const decimals = SOL_DECIMALS;
    const dstToken = SOL_MINT;
    const dstAmount = Math.floor((bridgeSolAmount + postFeeSol) * (10 ** decimals)).toString();

    console.log(`🚀 Starting bridge + post flow:`);
    console.log(`- Bridge amount: ${bridgeAmount} ${selectedInput.label.split(' on')[0]}`);
    console.log(`- Expected SOL received: ${bridgeSolAmount} SOL`);
    console.log(`- Post fee: ${postFeeSol} SOL`);
    console.log('⚠️  IMPORTANT: Only MetaMask should open first, then Phantom!');

    // STEP 1: CREATE BRIDGE TRANSACTION
    console.log('📋 Step 1: Creating bridge transaction...');
    const url = new URL(`${DEBRIDGE_API_BASE}/order/create-tx`);
    
    url.searchParams.append('srcChainId', selectedInput.chain.toString());
    url.searchParams.append('dstChainId', '7565164');
    url.searchParams.append('srcChainTokenIn', selectedInput.token);
    url.searchParams.append('dstChainTokenOut', dstToken);
    url.searchParams.append('srcChainTokenInAmount', ethers.parseUnits(bridgeAmount, selectedInput.decimals).toString());
    url.searchParams.append('dstChainTokenOutAmount', dstAmount);
    url.searchParams.append('prependOperatingExpense', 'true');
    url.searchParams.append('dstChainTokenOutRecipient', publicKey.toBase58());
    url.searchParams.append('srcChainOrderAuthorityAddress', evmAddress);
    url.searchParams.append('dstChainOrderAuthorityAddress', publicKey.toBase58());
    url.searchParams.append('affiliateFeePercent', AFFILIATE_PERCENT);
    url.searchParams.append('affiliateFeeRecipient', AFFILIATE_RECIPIENT);

    const response = await fetch(url.toString());
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Bridge tx creation failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log('✅ Bridge TX prepared for:', data.tx.to);

    // STEP 2: SIGN & SEND WITH METAMASK
    console.log('🦊 Step 2: Opening MetaMask ONLY...');
    const signer = await evmProvider.getSigner();

    const txResponse = await signer.sendTransaction({
      to: data.tx.to,
      data: data.tx.data,
      value: BigInt(data.tx.value || 0),
      gasLimit: BigInt(300000),
      gasPrice: await evmProvider.getFeeData().then(fee => fee.gasPrice),
    });

    console.log('🌉 MetaMask TX sent:', txResponse.hash);

    // STEP 3: WAIT FOR BRIDGE CONFIRMATION
    console.log('⏳ Step 3: Waiting for EVM confirmation...');
    const receipt = await txResponse.wait();
    console.log('✅ Bridge TX confirmed! Block:', receipt.blockNumber);

    // STEP 4: POLL FOR ORDER ID
    console.log('🔍 Step 4: Polling for order ID...');
    const orderId = await pollForOrderId(txResponse.hash);
    if (!orderId) throw new Error('Order ID timeout after 2 minutes');

    // STEP 5: POLL FOR FULFILLMENT
    console.log('⏳ Step 5: Waiting for fulfillment...');
    const status = await pollForFulfillment(orderId);
    if (status !== 'Fulfilled') throw new Error(`Bridge ${status.toLowerCase()}`);
    await validateSolanaNetwork(provider.connection);

    // STEP 6: VERIFY SOL BALANCE
    console.log('💰 Step 6: Verifying SOL balance...');
    const solBalance = await verifySolBalance(publicKey, postFeeSol);
    if (!solBalance) throw new Error('Insufficient SOL for posting');

    console.log('✅ Bridge complete! Switching to Phantom...');

    // STEP 7: CREATE AND SEND POST TRANSACTION
    console.log('🎭 Step 7: Creating post for Phantom...');
    const signature = await createAndSendPost(
      `[${bridgePostCategory}] ${bridgePostContent}`,
      publicKey,
      forumPda,
      programID,
      provider
    );
    console.log('✅ Post created! Signature:', signature);

    // STEP 8: REFRESH DATA
    console.log('🔄 Step 8: Refreshing forum data...');
    await refreshForumData(program, forumPda, setForum, setPosts);

    console.log('🎉 COMPLETE! Bridge + Post successful!');
    
    // Reset state
    setShowBridge(false);
    setBridgePostContent('');
    setBridgePostCategory('General Chatting');
    setSelectedInput(null);
    setError(null);

  } catch (err) {
    console.error('❌ Failed:', err);
    setError(`Failed: ${err.message}`);
  } finally {
    setLoading(false);
  }
};

// Helper: Poll for Order ID
const pollForOrderId = async (txHash, maxPolls = 24) => {
  let orderId;
  let pollCount = 0;

  while (!orderId && pollCount < maxPolls) {
    try {
      const orderUrl = `https://dln.debridge.finance/v1.0/dln/tx/${txHash}/order-id`;
      const orderRes = await fetch(orderUrl);
      const orderData = await orderRes.json();
      orderId = orderData.orderId;

      if (orderId) {
        console.log('✅ Order ID:', orderId);
        return orderId;
      }
    } catch (err) {
      console.warn(`Order poll ${pollCount + 1}/${maxPolls} failed`);
    }

    pollCount++;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  return null;
};

// Helper: Poll for Fulfillment
const pollForFulfillment = async (orderId, maxPolls = 60) => {
  let status = 'Created';
  let pollCount = 0;

  while (status !== 'Fulfilled' && pollCount < maxPolls) {
    try {
      const statusUrl = `https://dln.debridge.finance/v1.0/dln/order/${orderId}/status`;
      const statusRes = await fetch(statusUrl);
      const statusData = await statusRes.json();
      status = statusData.status;

      console.log(`🌉 Status (${pollCount + 1}/${maxPolls}): ${status}`);

      if (status === 'Fulfilled') return status;
      if (status === 'Failed' || status === 'Expired') return status;

    } catch (err) {
      console.warn(`Status poll ${pollCount + 1} failed`);
    }

    pollCount++;
    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  return status;
};

// Helper: Verify SOL Balance
const verifySolBalance = async (publicKey, requiredSol) => {
  await new Promise(resolve => setTimeout(resolve, 5000));

  const freshConnection = new web3.Connection(MAINNET_RPC, {
    commitment: 'confirmed',
  });

  const solBalance = await freshConnection.getBalance(publicKey);
  const solReceived = solBalance / LAMPORTS_PER_SOL;

  console.log(`💰 Current SOL balance: ${solReceived.toFixed(6)} SOL`);

  return solBalance >= requiredSol * LAMPORTS_PER_SOL;
};

const validateSolanaNetwork = async (connection) => {
  try {
    const version = await connection.getVersion();
    console.log('✅ Solana cluster version:', version['solana-core']);
    
    // Basic validation that we're connected
    if (!version['solana-core']) {
      throw new Error('Could not verify Solana cluster');
    }
    return true;
  } catch (err) {
    throw new Error(
      `Network validation failed: ${err.message}\n\n` +
      'Solution: Open Phantom → Settings → Networks → Switch to Mainnet Beta'
    );
  }
}

// Helper: Create and Send Post Transaction
const createAndSendPost = async (content, publicKey, forumPda, programID, provider) => {
  const feeRecipient = POST_FEE_RECIPIENT;
  const forumData = await withRetry(() => program.account.forum.fetch(forumPda));
  const postCount = forumData.postCount.toNumber();
  
  const [postPda] = await PublicKey.findProgramAddress(
    [Buffer.from('post'), forumPda.toBuffer(), Buffer.from(new BN(postCount).toArray('le', 8))],
    programID
  );

  const feeRecipientInfo = await withRetry(() => provider.connection.getAccountInfo(feeRecipient));
  if (!feeRecipientInfo) {
    throw new Error('Fee recipient account does not exist');
  }

  const transaction = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 500000 })
  );

  transaction.add(
    await program.methods
      .createPost(content)
      .accounts({
        post: postPda,
        forum: forumPda,
        user: publicKey,
        feeRecipient,
        systemProgram: SystemProgram.programId,
      })
      .instruction()
  );

  console.log('🎭 Opening Phantom NOW...');
  return await sendAndConfirmWithRetry(provider, transaction);
};

// Helper: Refresh Forum Data
const refreshForumData = async (program, forumPda, setForum, setPosts) => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const forumData = await withRetry(() => program.account.forum.fetch(forumPda));
      setForum({
        admin: forumData.admin.toBase58(),
        postCount: forumData.postCount.toNumber(),
        replyCount: forumData.replyCount.toNumber(),
        reportCount: forumData.reportCount.toNumber(),
        version: forumData.version.toNumber(),
      });

      const postAccounts = await withRetry(() => program.account.post.all());
      const newPosts = postAccounts.map((account) => ({
        id: account.publicKey.toBase58(),
        author: account.account.author.toBase58(),
        content: account.account.content,
        rating: account.account.rating.toNumber(),
        timestamp: account.account.timestamp.toNumber(),
        postId: account.account.id.toNumber(),
        category: categorizePost(account.account.content),
        isReported: account.account.isReported,
        reportCount: account.account.reportCount.toNumber(),
      }));

      setPosts(newPosts);
      console.log('✅ Data refreshed');
      return;

    } catch (refreshErr) {
      console.warn(`Refresh attempt ${attempt}/3 failed`);
      if (attempt === 3) throw refreshErr;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
};

  useEffect(() => {
    if (showBridge && selectedInput) {
      estimateBridge();
    }
  }, [showBridge, selectedInput]);

  const categories = [
    'All',
    'General Chatting',
    'Meme Launches',
    'Solana Gems',
    'Politics',
    'Dev Help',
    'Announcements',
    'New Solana Dapps',
    'Solcial Discussion',
    'Starred Posts',
    'My Posts',
    ...(MODERATOR_PUBLIC_KEYS.some(mod => mod.toBase58() === publicKey?.toBase58()) || 
      publicKey?.toBase58() === ADMIN_PUBLIC_KEY.toBase58() ? ['Reported Posts'] : []),
  ];

  // BRIDGE POSTING BUTTONS
const BridgePostButtons = () => {
  const handlePostClick = async (token) => {
    if (!bridgePostContent.trim()) {
      setError('Please enter post content');
      return;
    }

    setSelectedInput(token);
    setLoading(true);
    
    try {
      // Estimate will happen in useEffect
      await new Promise(resolve => setTimeout(resolve, 500));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bridge-post-buttons flex gap-2 mt-2">
      {publicKey && bridgePostContent.trim() && (
        <>
          <button 
            onClick={() => handlePostClick(LIMITED_INPUT_TOKENS[0])}
            disabled={loading}
            className="flex-1 px-4 py-2 bg-green-400 text-black font-mono border border-green-600 rounded-none hover:bg-green-500 disabled:opacity-50"
          >
            Post with ETH (0.0073)
          </button>
          <button 
            onClick={() => handlePostClick(LIMITED_INPUT_TOKENS[1])}
            disabled={loading}
            className="flex-1 px-4 py-2 bg-green-400 text-black font-mono border border-green-600 rounded-none hover:bg-green-500 disabled:opacity-50"
          >
            Post with BNB (0.027)
          </button>
        </>
      )}
    </div>
  );
};

  const getRoleSymbol = (author) => {
    if (author === ADMIN_PUBLIC_KEY.toBase58()) {
      return '🌍';
    } else if (MODERATOR_PUBLIC_KEYS.some(key => key.toBase58() === author)) {
      return '🛡️';
    }
    return '';
  };

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-black text-green-400 font-mono p-2 md:p-4">
        {/* Terminal Header */}
        <div className="mb-4 p-1 border border-green-400 rounded-lg shadow-glow">
          <h1 className="text-xl md:text-2xl font-bold animate-pulse text-center">{terminalText}</h1>
          <p className="mt-1 text-xs text-center">Solana Social Forum - Powered by $SLCL</p>
          {publicKey && (
            <p className="mt-1 text-xs text-center">
              Connected: {publicKey.toBase58().slice(0, 8)}... | SOLCIAL Balance: {solcialBalance !== null ? solcialBalance : 'Loading...'}
            </p>
          )}
          <div className="mt-1 flex flex-col items-center gap-1">
            <div className="flex flex-col items-center gap-1">
              <WalletMultiButton className="!bg-green-400 !text-black !font-mono !rounded-none !border !border-green-600 hover:!bg-green-500 !px-2 !py-1 !text-xs" />
              <label className="flex items-center text-xs">
                <input
                  type="checkbox"
                  checked={useSolcial}
                  onChange={() => setUseSolcial(!useSolcial)}
                  className="mr-1 accent-green-400 w-10 h-10"
                />
                Pay with $SOLCIAL
              </label>
            </div>
            <img
              src="/logo.png"
              alt="Solcial Logo"
              className="w-96 h-64 object-contain border border-green-400 shadow-glow max-w-full"
            />
            <div className="mt-2">
              <button
                onClick={() => setShowWhitepaper(true)}
                className="px-4 py-2 bg-green-400 text-black font-mono border border-green-600 rounded-none hover:bg-green-500"
              >
                White Paper
              </button>
            </div>
            <div className="w-full flex justify-end mt-1">
              <div className="flex items-center space-x-2">
                {(MODERATOR_PUBLIC_KEYS.some(mod => mod.toBase58() === publicKey?.toBase58()) || 
                  publicKey?.toBase58() === ADMIN_PUBLIC_KEY.toBase58()) && (
                  <button
                    onClick={initializeForum}
                    disabled={loading || forum}
                    className={`px-2 py-1 text-xs font-mono ${forum ? 'bg-gray-600' : 'bg-green-400 text-black'} border border-green-600 rounded-none hover:bg-green-500 disabled:opacity-50`}
                  >
                    Initialize Social
                  </button>
                )}
                {publicKey?.toBase58() === ADMIN_PUBLIC_KEY.toBase58() && forum && (
                  <button
                    onClick={closeForum}
                    disabled={loading}
                    className="px-2 py-1 text-xs font-mono bg-red-400 text-black border border-red-600 rounded-none hover:bg-red-500 disabled:opacity-50"
                  >
                    Close Forum
                  </button>
                )}
              </div>
            </div>
          </div>
          {error && (
            <div className="mt-1 p-1 bg-red-900 text-red-200 border border-red-400 rounded-none text-xs">
              {error}
            </div>
          )}
        </div>
        {/* Post Creation Section */}
        {publicKey && (
          <div className="mb-4 p-2 border border-green-400 rounded-lg shadow-glow">
            <h2 className="text-lg font-bold text-center">Create Post</h2>
            <select
              value={newPostCategory}
              onChange={(e) => setNewPostCategory(e.target.value)}
              className="w-full p-1 mt-1 bg-black border border-green-400 text-green-400 font-mono text-xs rounded-none"
            >
              {categories
                .filter(category => category !== 'All' && category !== 'Starred Posts' && category !== 'My Posts' && category !== 'Reported Posts')
                .map(category => (
                  <option
                    key={category}
                    value={category}
                    disabled={category === 'Announcements' && publicKey?.toBase58() !== ADMIN_PUBLIC_KEY.toBase58()}
                  >
                    {category}
                  </option>
                ))}
            </select>
            <textarea
              value={newPostContent}
              onChange={(e) => setNewPostContent(e.target.value)}
              placeholder="Type your post content..."
              className="w-full h-24 p-1 mt-1 bg-black border border-green-400 text-green-400 font-mono text-xs rounded-none"
            />
            <div className="flex justify-end gap-2 mt-1">
              <button
                onClick={() => setShowCreatePost(false)}
                className="px-2 py-1 text-xs font-mono bg-gray-600 text-white border border-gray-400 rounded-none hover:bg-gray-500"
              >
                Cancel
              </button>
              <button
                onClick={createPost}
                disabled={loading || !newPostContent || !newPostCategory}
                className="px-2 py-1 text-xs font-mono bg-green-400 text-black border border-green-600 rounded-none hover:bg-green-500 disabled:opacity-50"
              >
                Submit Post
              </button>
            </div>
          </div>
        )}

        {/* Bridge Post Section */}
        {/* {publicKey && (
          <div className="mb-4 p-2 border border-green-400 rounded-lg shadow-glow">
            <h2 className="text-lg font-bold text-center">Create Post with Bridge</h2>
            <select
              value={bridgePostCategory}
              onChange={(e) => setBridgePostCategory(e.target.value)}
              className="w-full p-1 mt-1 bg-black border border-green-400 text-green-400 font-mono text-xs rounded-none"
            >
              {categories
                .filter(category => category !== 'All' && category !== 'Starred Posts' && category !== 'My Posts' && category !== 'Reported Posts')
                .map(category => (
                  <option
                    key={category}
                    value={category}
                    disabled={category === 'Announcements' && publicKey?.toBase58() !== ADMIN_PUBLIC_KEY.toBase58()}
                  >
                    {category}
                  </option>
                ))}
            </select>
            <textarea
              value={bridgePostContent}
              onChange={(e) => setBridgePostContent(e.target.value)}
              placeholder="Type your bridge post content..."
              className="w-full h-24 p-1 mt-1 bg-black border border-green-400 text-green-400 font-mono text-xs rounded-none"
            />
            <BridgePostButtons />
          </div>
        )} */}

        {/* Categories Navigation */}
        <div className="mb-8 flex flex-wrap gap-2">
          {categories.map((category) => (
            <button
              key={category}
              onClick={() => setActiveSection(category)}
              className={`px-4 py-2 font-mono border border-green-400 rounded-none ${
                activeSection === category ? 'bg-green-400 text-black' : 'bg-black text-green-400'
              } hover:bg-green-500 hover:text-black`}
            >
              {category}
            </button>
          ))}
        </div>

        {/* Posts Section */}
        <div className="space-y-4">
          {loading && (
            <div className="text-center text-green-400 animate-pulse">Loading social data...</div>
          )}
          {!loading && filteredPosts.length === 0 && (
            <div className="text-center text-green-400">No posts found in this category.</div>
          )}
          {filteredPosts.map((post) => (
            <div key={post.id} className="p-4 border border-green-400 rounded-lg shadow-glow">
              <div className="flex justify-between items-center mb-2">
                <div>
                  <p className="text-sm">Posted by {post.author.slice(0, 8)}...{getRoleSymbol(post.author)} at {new Date(post.timestamp * 1000).toLocaleString()}</p>
                  <p className="text-sm text-green-200">Category: {post.category}</p>
                </div>
                <div className="flex space-x-2">
                  <button
                    onClick={() => toggleStarPost(post.id)}
                    className={`px-2 py-1 font-mono border border-green-400 rounded-none ${
                      starredPosts.includes(post.id) ? 'bg-yellow-400 text-black' : 'bg-black text-green-400'
                    } hover:bg-yellow-500`}
                  >
                    {starredPosts.includes(post.id) ? 'Unstar' : 'Star'}
                  </button>
                  <button
                    onClick={() => ratePost(post.id, true)}
                    disabled={loading}
                    className="px-2 py-1 bg-green-400 text-black font-mono border border-green-600 rounded-none hover:bg-green-500 disabled:opacity-50"
                  >
                    Upvote ({post.rating})
                  </button>
                  <button
                    onClick={() => ratePost(post.id, false)}
                    disabled={loading}
                    className="px-2 py-1 bg-red-400 text-black font-mono border border-red-600 rounded-none hover:bg-red-500 disabled:opacity-50"
                  >
                    Downvote
                  </button>
                  {(MODERATOR_PUBLIC_KEYS.some(mod => mod.toBase58() === publicKey?.toBase58()) || 
                    publicKey?.toBase58() === ADMIN_PUBLIC_KEY.toBase58()) && (
                    <button
                      onClick={() => deletePost(post.id)}
                      disabled={loading}
                      className="px-2 py-1 bg-red-400 text-black font-mono border border-red-600 rounded-none hover:bg-red-500 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  )}
                  <button
                    onClick={() => setShowReportModal({ show: true, type: 'post', id: post.id })}
                    disabled={loading || post.isReported}
                    className="px-2 py-1 bg-yellow-400 text-black font-mono border border-yellow-600 rounded-none hover:bg-yellow-500 disabled:opacity-50"
                  >
                    Report
                  </button>
                </div>
              </div>
              <p className="mb-4">{post.content}</p>
              <button
                onClick={() => setShowReplyForm((prev) => ({ ...prev, [post.id]: !prev[post.id] }))}
                className="px-4 py-2 bg-green-400 text-black font-mono border border-green-600 rounded-none hover:bg-green-500"
              >
                {showReplyForm[post.id] ? 'Cancel Reply' : 'Reply'}
              </button>
              {showReplyForm[post.id] && (
                <div className="mt-4">
                  <textarea
                    value={newReplyContent[post.id] || ''}
                    onChange={(e) => setNewReplyContent((prev) => ({ ...prev, [post.id]: e.target.value }))}
                    placeholder="Enter your reply (max 280 characters)"
                    className="w-full p-2 mb-4 bg-black text-green-400 border border-green-400 rounded-none font-mono resize-none"
                    rows="3"
                    maxLength={280}
                    disabled={loading}
                  />
                  <button
                    onClick={() => createReply(post.id)}
                    disabled={loading || !newReplyContent[post.id]?.trim()}
                    className="px-4 py-2 bg-green-400 text-black font-mono border border-green-600 rounded-none hover:bg-green-500 disabled:opacity-50"
                  >
                    {loading ? 'Replying...' : `Reply (${useSolcial ? SOLCIAL_REPLY_FEE + ' SOLCIAL' : REPLY_FEE + ' SOL'})`}
                  </button>
                </div>
              )}
              <div className="mt-4 space-y-2">
                {replies
                  .filter((reply) => reply.postId === post.postId)
                  .sort((a, b) => b.timestamp - a.timestamp)
                  .map((reply) => (
                    <div key={reply.id} className="pl-4 border-l-2 border-green-400">
                      <div className="flex justify-between items-center mb-2">
                        <p className="text-sm">Replied by {reply.author.slice(0, 8)}...{getRoleSymbol(reply.author)} at {new Date(reply.timestamp * 1000).toLocaleString()}</p>
                        <div className="flex space-x-2">
                          <button
                            onClick={() => rateReply(reply.id, true)}
                            disabled={loading}
                            className="px-2 py-1 bg-green-400 text-black font-mono border border-green-600 rounded-none hover:bg-green-500 disabled:opacity-50"
                          >
                            Upvote ({reply.rating})
                          </button>
                          <button
                            onClick={() => rateReply(reply.id, false)}
                            disabled={loading}
                            className="px-2 py-1 bg-red-400 text-black font-mono border border-red-600 rounded-none hover:bg-red-500 disabled:opacity-50"
                          >
                            Downvote
                          </button>
                          {(MODERATOR_PUBLIC_KEYS.some(mod => mod.toBase58() === publicKey?.toBase58()) || 
                            publicKey?.toBase58() === ADMIN_PUBLIC_KEY.toBase58()) && (
                            <button
                              onClick={() => deleteReply(reply.id)}
                              disabled={loading}
                              className="px-2 py-1 bg-red-400 text-black font-mono border border-red-600 rounded-none hover:bg-red-500 disabled:opacity-50"
                            >
                              Delete
                            </button>
                          )}
                          <button
                            onClick={() => setShowReportModal({ show: true, type: 'reply', id: reply.id })}
                            disabled={loading || reply.isReported}
                            className="px-2 py-1 bg-yellow-400 text-black font-mono border border-yellow-600 rounded-none hover:bg-yellow-500 disabled:opacity-50"
                          >
                            Report
                          </button>
                        </div>
                      </div>
                      <p>{reply.content}</p>
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>

        {/* Reports Section for Admins/Moderators */}
        {(MODERATOR_PUBLIC_KEYS.some(mod => mod.toBase58() === publicKey?.toBase58()) || 
          publicKey?.toBase58() === ADMIN_PUBLIC_KEY.toBase58()) && activeSection === 'Reported Posts' && (
          <div className="mt-8 p-4 border border-green-400 rounded-lg shadow-glow">
            <h2 className="text-xl font-bold mb-4">Reported Content</h2>
            <div className="space-y-4">
              {postReports
                .filter((report) => !report.isResolved)
                .map((report) => (
                  <div key={report.id} className="p-4 bg-black border border-yellow-400 rounded-none">
                    <p className="text-sm">Post ID: {report.postId} | Reported by: {report.reporter.slice(0, 8)}...</p>
                    <p className="text-sm">Reason: {report.reason}</p>
                    <p className="text-sm">Reported at: {new Date(report.timestamp * 1000).toLocaleString()}</p>
                    <div className="mt-2 flex space-x-2">
                      <button
                        onClick={() => {
                          const action = prompt('Enter action taken (max 100 chars):');
                          if (action) resolveReport(report.id, action, true);
                        }}
                        disabled={loading}
                        className="px-4 py-2 bg-green-400 text-black font-mono border border-green-600 rounded-none hover:bg-green-500 disabled:opacity-50"
                      >
                        Resolve
                      </button>
                      <button
                        onClick={() => closeReport(report.id, true)}
                        disabled={loading}
                        className="px-4 py-2 bg-red-400 text-black font-mono border border-red-600 rounded-none hover:bg-red-500 disabled:opacity-50"
                      >
                        Close
                      </button>
                    </div>
                  </div>
                ))}
              {replyReports
                .filter((report) => !report.isResolved)
                .map((report) => (
                  <div key={report.id} className="p-4 bg-black border border-yellow-400 rounded-none">
                    <p className="text-sm">Reply ID: {report.replyId} | Reported by: {report.reporter.slice(0, 8)}...</p>
                    <p className="text-sm">Reason: {report.reason}</p>
                    <p className="text-sm">Reported at: {new Date(report.timestamp * 1000).toLocaleString()}</p>
                    <div className="mt-2 flex space-x-2">
                      <button
                        onClick={() => {
                          const action = prompt('Enter action taken (max 100 chars):');
                          if (action) resolveReport(report.id, action, false);
                        }}
                        disabled={loading}
                        className="px-4 py-2 bg-green-400 text-black font-mono border border-green-600 rounded-none hover:bg-green-500 disabled:opacity-50"
                      >
                        Resolve
                      </button>
                      <button
                        onClick={() => closeReport(report.id, false)}
                        disabled={loading}
                        className="px-4 py-2 bg-red-400 text-black font-mono border border-red-600 rounded-none hover:bg-red-500 disabled:opacity-50"
                      >
                        Close
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Report Modal */}
        {showReportModal.show && (
          <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
            <div className="p-4 bg-black border border-green-400 rounded-none shadow-glow max-w-md w-full">
              <h2 className="text-xl font-bold mb-4">Report {showReportModal.type === 'post' ? 'Post' : 'Reply'}</h2>
              <textarea
                value={reportReason}
                onChange={(e) => setReportReason(e.target.value)}
                placeholder="Enter reason for report (max 100 characters)"
                className="w-full p-2 mb-4 bg-black text-green-400 border border-green-400 rounded-none font-mono resize-none"
                rows="3"
                maxLength={100}
                disabled={loading}
              />
              <div className="flex justify-end space-x-2">
                <button
                  onClick={() => setShowReportModal({ show: false, type: null, id: null })}
                  disabled={loading}
                  className="px-4 py-2 bg-red-400 text-black font-mono border border-red-600 rounded-none hover:bg-red-500 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => showReportModal.type === 'post' ? reportPost(showReportModal.id) : reportReply(showReportModal.id)}
                  disabled={loading || !reportReason.trim()}
                  className="px-4 py-2 bg-green-400 text-black font-mono border border-green-600 rounded-none hover:bg-green-500 disabled:opacity-50"
                >
                  {loading ? 'Reporting...' : `Submit (${useSolcial ? SOLCIAL_REPORT_FEE + ' SOLCIAL' : REPORT_FEE + ' SOL'})`}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Middle Right Side Boxes */}
        <div className="fixed right-4 top-4 z-40">
          {/* Commented out the Bridge button */}
          {/*
          <div className="p-4 bg-black border border-green-400 rounded-lg shadow-glow">
            <button
              onClick={() => setShowBridge(true)}
              className="w-full px-4 py-2 bg-green-400 text-black font-mono border border-green-600 rounded-none hover:bg-green-500"
            >
              Bridge
            </button>
          </div>
          */}
        </div>

        {/* Whitepaper Modal */}
        {showWhitepaper && (
          <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
            <div className="p-4 bg-black border border-green-400 rounded-none shadow-glow max-w-4xl w-full h-3/4">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-xl font-bold">White Paper</h2>
                <button
                  onClick={() => setShowWhitepaper(false)}
                  className="px-2 py-1 bg-red-400 text-black font-mono border border-red-600 rounded-none hover:bg-red-500"
                >
                  Close
                </button>
              </div>
              <iframe
                src="/whitepaper.pdf"
                className="w-full h-full border border-green-400"
                title="White Paper"
              />
            </div>
          </div>
        )}

        {/* Bridge Modal */}
        {showBridge && (
  <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
    <div className="p-4 bg-black border border-green-400 rounded-none shadow-glow max-w-2xl w-full max-h-[80vh]">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold">{selectedInput ? 'Create Post' : 'Select Payment Coin'}</h2>
        <button
          onClick={() => setShowBridge(false)}
          className="px-2 py-1 bg-red-400 text-black font-mono border border-red-600 rounded-none hover:bg-red-500"
        >
          Close
        </button>
      </div>
      
      {!selectedInput ? (
        // Coin Selection
        <div className="space-y-2">
          {LIMITED_INPUT_TOKENS.map((token) => (
            <button
              key={token.label}
              onClick={() => setSelectedInput(token)}
              className="w-full px-4 py-2 bg-green-400 text-black font-mono border border-green-600 rounded-none hover:bg-green-500"
            >
              Post with {token.label.split(' on')[0]}
            </button>
          ))}
        </div>
      ) : (
        // Post Creation with Estimation
        <>
          <select
            value={bridgePostCategory}
            onChange={(e) => setBridgePostCategory(e.target.value)}
            className="w-full p-1 mb-2 bg-black border border-green-400 text-green-400 font-mono text-xs rounded-none"
          >
            {categories
                .filter(category => category !== 'All' && category !== 'Starred Posts' && category !== 'My Posts' && category !== 'Reported Posts')
                .map(category => (
                  <option
                    key={category}
                    value={category}
                    disabled={category === 'Announcements' && publicKey?.toBase58() !== ADMIN_PUBLIC_KEY.toBase58()}
                  >
                    {category}
                  </option>
                ))}
          </select>
          
          <textarea
            value={bridgePostContent}
            onChange={(e) => setBridgePostContent(e.target.value)}
            placeholder="Type your bridge post content..."
            className="w-full h-24 p-1 mb-2 bg-black border border-green-400 text-green-400 font-mono text-xs rounded-none"
          />
          
          {/* ESTIMATION STATUS */}
          <div className="mb-4 p-2 bg-gray-900 border border-green-400 rounded-none">
            <p className="text-xs font-mono">
              <strong>Bridge Setup:</strong><br/>
              Token: {selectedInput.label.split(' on')[0]} → SOL<br/>
              {loading ? (
                '⏳ Estimating bridge cost...'
              ) : estimationInfo ? (
                `✅ Ready: ${bridgeAmount} ${selectedInput.label.split(' on')[0]} → ${BASE_BRIDGE_AMOUNT + POST_FEE} SOL`
              ) : (
                '⚠️ Click Post button to estimate'
              )}
            </p>
          </div>
          
          {/* WALLET CONNECTIONS */}
          {!evmAddress && (
            <button
              onClick={connectEvmWallet}
              className="w-full px-4 py-2 mb-2 bg-orange-400 text-black font-mono border border-orange-600 rounded-none hover:bg-orange-500"
            >
              🦊 Connect MetaMask
            </button>
          )}
          
          {!publicKey && (
            <WalletMultiButton className="!bg-purple-400 !text-black !font-mono !rounded-none !border !border-purple-600 hover:!bg-purple-500 !px-2 !py-1 !text-xs w-full mb-2" />
          )}
          
          {/* MAIN POST BUTTON */}
          <button
            onClick={handleBridgeAndPost}
            disabled={loading || !bridgePostContent.trim() || !evmAddress || !publicKey || !estimationInfo}
            className="w-full px-4 py-2 bg-green-400 text-black font-mono border border-green-600 rounded-none hover:bg-green-500 disabled:opacity-50"
          >
            {loading ? '🚀 Processing Bridge...' : 
             !estimationInfo ? 'Estimate First' : 
             '📝 Post with Bridge'}
          </button>
          
          <button
            onClick={() => setSelectedInput(null)}
            className="w-full px-4 py-2 mt-2 bg-gray-600 text-white font-mono border border-gray-400 rounded-none hover:bg-gray-500"
          >
            ← Back to Coin Selection
          </button>
        </>
      )}
      
      <p className="text-xs mt-2 text-center text-green-200">
        Seamless cross-chain posting powered by DeBridge
      </p>
    </div>
  </div>
)}
      </div>

      {/* Custom CSS for Retro Terminal Aesthetic */}
      <style jsx>{`
        .shadow-glow {
          box-shadow: 0 0 10px rgba(0, 255, 0, 0.5), 0 0 20px rgba(0, 255, 0, 0.3);
        }
        .animate-pulse {
          animation: pulse 2s infinite;
        }
        @keyframes pulse {
          0% {
            opacity: 1;
          }
          50% {
            opacity: 0.5;
          }
          100% {
            opacity: 1;
          }
        }
        button:hover {
          transform: scale(1.05);
          transition: transform 0.2s;
        }
        textarea:focus, select:focus {
          outline: none;
          box-shadow: 0 0 5px rgba(0, 255, 0, 0.7);
        }
        input[type="checkbox"] {
          appearance: none;
          width: 16px;
          height: 16px;
          border: 2px solid #00ff00;
          background: #000;
          cursor: pointer;
        }
        input[type="checkbox"]:checked {
          background: #00ff00;
          position: relative;
        }
        input[type="checkbox"]:checked::after {
          content: '✓';
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          color: #000;
          font-weight: bold;
        }
      `}</style>
    </ErrorBoundary>
  );
}
