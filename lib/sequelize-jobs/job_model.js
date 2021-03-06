var lockStrategy = require('./lock_strategy'),
  moment = require('moment'),
  util = require('util');

var ensureStringData = function(data) {
  return JSON.stringify(data);
};

var ensureJSONData = function(data) {
  data = data || '{}';
  var parsed = JSON.parse(data);

  return parsed;
};

module.exports = function(Jobs) {
  var db = Jobs.db;
  var Sequelize = Jobs.Sequelize;

  var JobModel = db.define("sequelizeJob", {
    id: {
      type: Sequelize.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    // Allows some jobs to jump to the front of the queue
    priority: {
      type: Sequelize.INTEGER,
      defaultValue: 0,
    },

    // string of the worker model that will do work
    handler: {
      type: Sequelize.STRING,
      allowNull: false,
    },

    // custom data of the job. will be json
    data: {
      type: Sequelize.TEXT,
      allowNull: true,
    },

    // reason for last failure (See Note below)
    lastError: {
      type: Sequelize.TEXT,
      allowNull: true,
    },

    attempts: {
      type: Sequelize.INTEGER,
      defaultValue: 0,
    },

    createdAt: {
      type: Sequelize.DATE,
      allowNull: false,
    },

    updatedAt: {
      type: Sequelize.DATE,
      allowNull: false,
    },

    // When to run. Could be Time.zone.now for immediately, or sometime in the future.
    runAt: {
      type: Sequelize.DATE,
      allowNull: false,
    },

    // Set when a client is working on this object
    lockedAt: {
      type: Sequelize.DATE,
      allowNull: true,
    },

    // Set when all retries have failed (actually, by default, the record is deleted instead)
    failedAt: {
      type: Sequelize.DATE,
      allowNull: true,
    },

    // Who is working on this object (if locked)
    lockedBy: {
      type: Sequelize.STRING,
      allowNull: true,
    },

    // The name of the queue this job is in
    queue: {
      type: Sequelize.STRING,
      allowNull: false,
      defaultValue: "default",
    }
  }, {
    setterMethods: {
      data: function(v) {
        this.setDataValue('data', ensureStringData(v));
      }
    },
    getterMethods: {
      data: function() {
        return ensureJSONData(this.getDataValue('data'));
      }
    },
    instanceMethods: {
      // not saved in DB
      _unlock: function() {
        this.lockedAt = null;
        this.lockedBy = null;
      },

      _failedEventually: function() {
        return this.updateAttributes({
          failedAt: JobModel.dbTimeNow()
        });
      },

      _handleFailed: function(err) {
        this.lastError = util.inspect(err, {
          depth: 1,
        });

        return this._reschedule();
      },

      _reschedule: function() {
        this.attempts += 1;

        // FIXME: put maxAttempts setting somewhere else than
        // on the global Jobs object.
        if (this.attempts >= Jobs.options.maxAttempts) {
          return this._failedEventually();
        }

        this.runAt = moment(JobModel.dbTimeNow())
          .add('seconds', Math.pow(this.attempts, 4) + 5)
          .toDate();

        this._unlock();

        return this.save();
      },

      _completed: function() {
        return this.destroy();
      }
    },
    classMethods: {
      dbTimeNow: function() {
        return new Date();
      },

      reserve: function(worker) {
        var now = JobModel.dbTimeNow();
        var maxRunTime = 0;

        // FIXME: make this a setting
        var dbLockTime = moment(now).subtract('minutes', 60).toDate();

        var workerId = worker.id;
        var promise = Sequelize.Utils.Promise;

        promise.prototype.run = function() {
          Sequelize.Utils.tick(function() {
            if (this.fct) {
              this.fct.call(this, this)
            }
          }.bind(this))

          return this
        };

        var additionalConstraints = {};

        if (worker.options.queue) additionalConstraints.queue = worker.options.queue;

        // (runAt <= ? AND (lockedAt IS NULL OR lockedAt < ?) OR lockedBy = ?) AND failedAt IS NULL')
        var condition = Sequelize.and(
          Sequelize.or(
            Sequelize.and(
              { runAt: { lte: now } },
              Sequelize.or(
                { lockedAt: null},
                { lockedAt: { lt: dbLockTime }}
              )
            ),
            { lockedBy: workerId }
          ),
          { failedAt: null },
          additionalConstraints
        );

        var lockRequest = {
          Jobs: Jobs,
          model: JobModel,
          condition: { where: condition },
          worker: worker,
          now: now,
        };

        var proc = new promise(function(resolve, reject) {
          lockRequest.promise = { resolve, reject };

          var strategy = lockStrategy[db.getDialect()];

          if (strategy) {
            strategy(lockRequest);
          } else {
            lockStrategy.default(lockRequest);
          }
        });

        return proc.run();
      }
    }
  });

  JobModel.sync();

  return JobModel;
};
