const Model = require("../Model");

class Source extends Model {
  sourcePath;
  contents;

  async beforeSave() {
    const newId = this.generateID();

    // Key exists in db, but data fields have changed so remove old key
    // This could also become a batch operation and would then be atomic
    if (this.id && this.id !== newId) {
      await Source.delete(this.id);
    }
    this.id = newId;
  }

  generateID() {
    return this.sha3(
      JSON.stringify(this.sourcePath) + JSON.stringify(this.contents)
    );
  }
}

module.exports = Source;
