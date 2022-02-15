const Model = require("../Model");

class ContractInstance extends Model {
  address;
  network;
  creation;
  callBytecode;
  contract;

  async beforeSave() {
    const newId = this.generateID();

    // Key exists in db, but data fields have changed so remove old key
    // This could also become a batch operation and would then be atomic
    if (this.id && this.id !== newId) {
      await ContractInstance.delete(this.id);
    }
    this.id = newId;
  }

  generateID() {
    return this.sha3(
      JSON.stringify(this.contract) +
        this.address +
        JSON.stringify(this.creation)
    );
  }
}

module.exports = ContractInstance;
