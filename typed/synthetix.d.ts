declare module 'synthetix' {
  function getTarget({
    network: string,
    contract: string,
  }): {
    address: string;
  };

  function getSource({
    network: string,
    contract: string,
  }): {
    abi: any;
  };
}

declare module '@horizon-protocol/smart-contract' {
  function getTarget({
    network: string,
    contract: string,
  }): {
    address: string;
  };

  function getSource({
    network: string,
    contract: string,
  }): {
    abi: any;
  };
}
