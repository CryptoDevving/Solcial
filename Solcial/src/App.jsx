import React, { useMemo } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { clusterApiUrl } from '@solana/web3.js';
import Social from './Social';
import '@solana/wallet-adapter-react-ui/styles.css';

export default function App() {
  const network = process.env.REACT_APP_SOLANA_RPC || clusterApiUrl('testnet');
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);

  return (
    <ConnectionProvider endpoint={network}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <Social />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
