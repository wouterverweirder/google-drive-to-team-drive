const Sema = require(`async-sema`);

class PromiseSemaphore {
  constructor(nr) {
    this.sema = new Sema(10);
    this.tasks = [];
    this.numTasksBusy = 0;
  }
  isDone() {
    return (this.numTasksBusy === 0 && this.sema.nrWaiting() === 0);
  }
  add(promiseCreator) {
    const task = Promise.resolve()
      .then(() => this.sema.v())
      .then(() => this.numTasksBusy++)
      .then(() => promiseCreator())
      .then(() => this.sema.p())
      .then(() => this.numTasksBusy--);
    this.tasks.push(task);
  }
  start() {
    const checkEmptyQueueTask = () => {
      return Promise.resolve()
        .then(() => {
          if (!this.isDone()) {
            return Promise.all(this.tasks).then(() => checkEmptyQueueTask());
          }
        });
    };
    return Promise.all(this.tasks)
      .then(() => checkEmptyQueueTask());
  }
}

module.exports = PromiseSemaphore;
