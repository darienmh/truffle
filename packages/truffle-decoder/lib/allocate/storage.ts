import debugModule from "debug";
const debug = debugModule("decoder:allocate:storage");

import { AstReferences, StorageAllocations, StorageAllocation, StorageMemberAllocations } from "../interface/contract-decoder";
import { StoragePointer } from "../types/pointer";
import { AstDefinition } from "truffle-decode-utils/src/ast";
import * as DecodeUtils from "truffle-decode-utils";
import BN from "bn.js";

export type StorageLength = {bytes: number} | {words: BN};

export function isWordsLength(size: StorageLength): size is {words: BN} {
  return (<{words: BN}>size).words !== undefined;
}

//temporary HACK, to be removed in next PR (or soon, anyway)
export function storageLengthToBytes(size: StorageLength): number {
  if(isWordsLength(size)) {
    return size.words.muln(DecodeUtils.EVM.WORD_SIZE).toNumber(); //HACK
  }
  else {
    return size.bytes;
  }
}

//contracts contains only the contracts to be allocated; any base classes not
//being allocated should just be in referenceDeclarations
export function getStorageAllocations(referenceDeclarations: AstReferences, contracts: AstReferences): StorageAllocations {
  let allocations: StorageAllocations = {};
  for(const node of Object.values(referenceDeclarations)) {
    if(node.nodeType === "StructDefinition")
      allocations = allocateStruct(node, referenceDeclarations, allocations);
  }
  for(const contract of Object.values(contracts)) {
    allocations = allocateContract(contract, referenceDeclarations, allocations);
  }
  return allocations;
}

function allocateStruct(structDefinition: AstDefinition, referenceDeclarations: AstReferences, existingAllocations: StorageAllocations): StorageAllocations {
  return allocateMembers(structDefinition, structDefinition.members, referenceDeclarations, existingAllocations);
}

function allocateMembers(parentNode: AstDefinition, definitions: AstDefinition[], referenceDeclarations: AstReferences, existingAllocations: StorageAllocations, suppressSize: boolean = false): StorageAllocations {
  let offset = new BN(0);
  let index = DecodeUtils.EVM.WORD_SIZE - 1;

  //don't allocate things that have already been allocated
  if(parentNode.id in existingAllocations) {
    return existingAllocations;
  }

  let allocations = {...existingAllocations}; //otherwise, we'll be adding to this, so we better clone

  //otherwise, we need to allocate
  let memberAllocations: StorageMemberAllocations = {}

  for(const node of definitions)
  {
    //note: in the future, we will begin by checking if node is constant
    //and if so doing things a different way to allocate a literal for it
    let size: StorageLength;
    [size, allocations] = storageSizeAndAllocate(node, referenceDeclarations, allocations);

    if (isWordsLength(size) || size.bytes < index + 1) {
      //if it's sized in words, we need to start on a new slot;
      //if it's sized in bytes but there's not enough room, we also need a new slot
      index = DecodeUtils.EVM.WORD_SIZE - 1;
      offset.iaddn(1);
    }
    //otherwise, we remain in place
  
    let range: DecodeUtils.Allocation.Range;

    if(isWordsLength(size)) {
      //words case
      range = {
        from: {
          slot: {
            offset: offset.clone() //start at the current slot...
          },
          index: 0 //...at the beginning of the word.
        },
        to: {
          slot: {
            offset: offset.add(size.words).subn(1) //end at the current slot plus # of words minus 1...
          },
          index: DecodeUtils.EVM.WORD_SIZE - 1 //...at the end of the word.
        },
      };
    }
    else {
      //bytes case
      range = {
        from: {
          slot: {
            offset: offset.clone() //start at the current slot...
          },
          index: index - size.bytes //...early enough to fit what's being allocated.
        },
        to: {
          slot: {
            offset: offset.clone() //end at the current slot...
          },
          index: index //...at the current position.
        },
      };
    }
  
    memberAllocations[node.id] = {
      definition: node,
      pointer: {
        storage: range //don't think we need to clone here...
      }
    };
  
    //finally, adjust the current position.
    //if it was sized in words, move down that many slots and reset position w/in slot
    if(isWordsLength(size)) {
      offset.iadd(size.words);
      index = DecodeUtils.EVM.WORD_SIZE - 1;
    }
    //if it was sized in bytes, move down an appropriate number of bytes.
    else {
      index -= size.bytes;
      //but if this puts us into the next word, move to the next word.
      if(index < 0) {
        index = DecodeUtils.EVM.WORD_SIZE - 1;
        offset.iaddn(1);
      }
    }
  }

  //having made our allocation, let's add it to allocations!
  allocations[parentNode.id] = {
    definition: parentNode,
    members: memberAllocations
  };

  //finally, let's determine the overall size (unless suppressSize was passed)
  //we do this assuming we're dealing with a struct, so the size is measured in words
  //it's one plus the last word used, i.e. one plus the current word... unless the
  //current word remains entirely unused, then it's just the current word
  if(!suppressSize) {
    allocations[parentNode.id].size = (index === DecodeUtils.EVM.WORD_SIZE - 1) ?
      {words: offset.clone()} : {words: offset.addn(1)};
  }

  //...and we're done!
  return allocations;
}

function getStateVariables(contractNode: AstDefinition): AstDefinition[] {
  // process for state variables, filtering out constants
  return contractNode.nodes.filter( (node: AstDefinition) =>
    node.nodeType === "VariableDeclaration" && node.stateVariable && !node.constant
  );
  //note, in the future, we will not filter out constants
}

function allocateContract(contract: AstDefinition, referenceDeclarations: AstReferences, existingAllocations: StorageAllocations): StorageAllocations {

  let allocations: StorageAllocations = {...existingAllocations};

  //base contracts are listed from most derived to most base, so we
  //have to reverse before processing, but reverse() is in place, so we
  //clone with slice first
  let linearizedBaseContractsFromBase: number[] = contract.linearizedBaseContracts.slice().reverse();

  debug("LBCFB %o", linearizedBaseContractsFromBase);
  debug("ref decl ids %o", Object.keys(referenceDeclarations));

  let vars = [].concat(...linearizedBaseContractsFromBase.map( (id: number) =>
    getStateVariables(referenceDeclarations[id])
  ));

  return allocateMembers(contract, vars, referenceDeclarations, existingAllocations, true); 
    //size is not meaningful for contracts, so we pass suppressSize=true
}

//NOTE: This wrapper function is for use by the decoder ONLY, after allocation is done.
//The allocator should (and does) instead use a direct call to storageSizeAndAllocate,
//not to the wrapper, because it may need the allocations returned.
export function storageSize(definition: AstDefinition, referenceDeclarations?: AstReferences, allocations?: StorageAllocations): StorageLength {
  return storageSizeAndAllocate(definition, referenceDeclarations, allocations)[0];
}

//first return value is the actual size.
//second return value is resulting allocations, INCLUDING the ones passed in
function storageSizeAndAllocate(definition: AstDefinition, referenceDeclarations?: AstReferences, existingAllocations?: StorageAllocations): [StorageLength, StorageAllocations] {
  switch (DecodeUtils.Definition.typeClass(definition)) {
    case "bool":
      return [{bytes: 1}, existingAllocations];

    case "address":
    case "contract":
      return [{bytes: 20}, existingAllocations];

    case "int":
    case "uint": {
      return [{bytes: DecodeUtils.Definition.specifiedSize(definition) || 32 }, existingAllocations]; // default of 256 bits
      //(should 32 here be WORD_SIZE?  I thought so, but comparing with case
      //of fixed/ufixed makes the appropriate generalization less clear)
    }

    case "fixed":
    case "ufixed": {
      return [{bytes: DecodeUtils.Definition.specifiedSize(definition) || 16 }, existingAllocations]; // default of 128 bits
    }

    case "enum": {
      const referenceId: number = definition.referencedDeclaration;
      const referenceDeclaration: AstDefinition = referenceDeclarations[referenceId];
      const numValues: number = referenceDeclaration.members.length;
      return [{bytes: Math.ceil(Math.log2(numValues) / 8)}, existingAllocations];
    }

    case "bytes": {
      //this case is really two different cases!
      const staticSize: number = DecodeUtils.Definition.specifiedSize(definition);
      if(staticSize) {
        return [{bytes: staticSize}, existingAllocations];
      }
      else
      {
        return [{words: new BN(1)}, existingAllocations];
      }
    }

    case "string":
      return [{words: new BN(1)}, existingAllocations];

    case "mapping":
      return [{words: new BN(1)}, existingAllocations];

    case "function": {
      //this case is also really two different cases
      switch (DecodeUtils.Definition.visibility(definition)) {
        case "internal":
          return [{bytes: 8}, existingAllocations];
        case "external":
          return [{bytes: 24}, existingAllocations];
      }
    }

    case "array": {
      if(DecodeUtils.Definition.isDynamicArray(definition)) {
        return [{words: new BN(1)}, existingAllocations];
      }
      else {
        //static array case
        const length: string = definition.length || definition.typeName.length;
        const baseDefinition: AstDefinition = definition.baseType || definition.typeName.baseType;
        const [baseSize, allocations] = storageSizeAndAllocate(baseDefinition, referenceDeclarations, existingAllocations);
        if(!isWordsLength(baseSize)) {
          //bytes case
          const perWord: number = Math.floor(DecodeUtils.EVM.WORD_SIZE / baseSize.bytes);
          //bn.js has no ceiling-division, so we'll do a floor-division and then
          //increment if not a multiple
          const lengthBN: BN = new BN(length);
          let numWords: BN = lengthBN.divn(perWord); //floor
          if(lengthBN.modn(perWord) !== 0) { //modn returns a number, not a BN
            numWords.iaddn(1); //increment if not multiple
          }
          return [{words: numWords}, allocations];
        }
        else {
          //words case
          return [{words: baseSize.words.mul(new BN(length))}, allocations];
        }
      }
    }

    case "struct": {
      const referenceId: number = definition.referencedDeclaration;
      let allocations: StorageAllocations = existingAllocations;
      let allocation: StorageAllocation | undefined = allocations[referenceId]; //may be undefined!
      if(allocation === undefined) {
        //if we don't find an allocation, we'll have to do the allocation ourselves
        allocations = allocateStruct(definition, referenceDeclarations, existingAllocations);
        allocation = allocations[referenceId];
      }
      //having found our allocation, we can just look up its size
      return [allocation.size, allocations];
    }
  }
}
