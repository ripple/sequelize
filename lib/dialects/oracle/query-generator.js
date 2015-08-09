'use strict';

/* jshint -W110 */
var Utils = require('../../utils')
  , DataTypes = require('../../data-types')
  , Transaction = require('../../transaction')
  , _ = require('lodash');

var OracleQueryGenerator = _.extend(
  _.clone(require('../abstract/query-generator'))
);

var QueryGenerator = {
  options: {},
  dialect: 'oracle',

  createSchema: function(schema) {
    console.trace();
    return [
        'DECLARE',
        '  V_COUNT INTEGER;',
        '  V_CURSOR_NAME INTEGER;',
        '  V_RET INTEGER;',
        'BEGIN',
        '  SELECT COUNT(1) INTO V_COUNT FROM ALL_USERS WHERE USERNAME = ', wrapSingleQuote(schema),';',
        '  IF V_COUNT = 0 THEN',
        '    EXECUTE IMMEDIATE', wrapSingleQuote('CREATE USER ' + wrapSingleQuote(schema) + ' IDENTIFIED BY 12345'), ';',
        '    EXECUTE IMMEDIATE', wrapSingleQuote('GRANT create session TO ' + wrapSingleQuote(schema)), ';',
        '    EXECUTE IMMEDIATE', wrapSingleQuote('GRANT create table TO ' + wrapSingleQuote(schema)), ';',
        '    EXECUTE IMMEDIATE', wrapSingleQuote('GRANT create view TO ' + wrapSingleQuote(schema)), ';',
        '    EXECUTE IMMEDIATE', wrapSingleQuote('GRANT create any trigger TO ' + wrapSingleQuote(schema)), ';',
        '    EXECUTE IMMEDIATE', wrapSingleQuote('GRANT create any procedure TO ' + wrapSingleQuote(schema)), ';',
        '    EXECUTE IMMEDIATE', wrapSingleQuote('GRANT create sequence TO ' + wrapSingleQuote(schema)), ';',
        '    EXECUTE IMMEDIATE', wrapSingleQuote('GRANT create synonym TO ' + wrapSingleQuote(schema)), ';',
        '    EXECUTE IMMEDIATE', wrapSingleQuote('GRANT UNLIMITED TABLESPACE TO ' + wrapSingleQuote(schema)), ';',
        '  END IF;',
        'END;',
    ].join(' ');
  },

  showSchemasQuery: function() {
    return "SELECT USERNAME FROM ALL_USERS;";
  },

  versionQuery: function() {
    return 'SELECT VERSION FROM PRODUCT_COMPONENT_VERSION GROUP BY VERSION';
  },
  
  dropTableQuery: function(tableName, options) {
    options = options || {};

    var query = [
        'DECLARE',
          'V_COUNT INTEGER;',
          'V_CURSOR_NAME INTEGER;',
          'V_RET INTEGER;',
        'BEGIN',
          'SELECT COUNT(1) INTO V_COUNT FROM USER_TABLES WHERE TABLE_NAME = ', wrapSingleQuote(tableName),';',
          'IF V_COUNT = 1 THEN',
            'V_CURSOR_NAME := DBMS_SQL.OPEN_CURSOR;',
            'DBMS_SQL.PARSE(V_CURSOR_NAME, \'DROP TABLE <%= table %>\', DBMS_SQL.NATIVE);',
            'V_RET := DBMS_SQL.EXECUTE(V_CURSOR_NAME);',
          'END IF;',
        'END;',
    ].join(' ');

    return _.template(query)({
      table: this.quoteTable(tableName)
    });
  },

  createTableQuery: function(tableName, attributes, options) {
    var query = 'CREATE TABLE <%= table %> (<%= attributes%>)'
      , attrStr = [];
      
    for (var attr in attributes) {
      attrStr.push(this.quoteIdentifier(attr) + ' ' + attributes[attr]);
    }

    var values = {
      table: this.quoteTable(tableName),
      attributes: attrStr.join(', '),
    };

    var sql = _.template(query)(values).trim();
    return this.replaceBooleanDefaults(sql);
  },

  booleanValue: function(value){
    return !!value ? 1 : 0;
  },

  addLimitAndOffset: function(options){
    var fragment = '';
    if (options.offset && !options.limit) {
      fragment += ' LIMIT ' + options.offset + ', ' + 10000000000000;
    } else if (options.limit) {
      if (options.offset) {
        fragment += ' LIMIT ' + options.offset + ', ' + options.limit;
      } else {
        fragment += ' LIMIT ' + options.limit;
      }
    }

    return fragment;
  },

  addColumnQuery: function(table, key, dataType) {
    var query = 'ALTER TABLE <%= table %> ADD <%= attribute %>;'
      , attributes = {};

    attributes[key] = dataType;
    var fields = this.attributesToSQL(attributes, {
      context: 'addColumn'
    });
    var attribute = _.template('<%= key %> <%= definition %>')({
        key: this.quoteIdentifier(key),
        definition: fields[key]
      });

    var sql =  _.template(query)({
      table: this.quoteTable(table),
      attribute: attribute
    });

    return this.replaceBooleanDefaults(sql);
  },

  showTablesQuery: function() {
    return "SELECT TABLE_NAME FROM USER_TABLES";
  },

  upsertQuery: function (tableName, insertValues, updateValues, where, rawAttributes, options) {
    options.ignore = true;
    var sql = this.insertQuery(tableName, insertValues, rawAttributes, options) + ' ' + this.updateQuery(tableName, updateValues, where, options, rawAttributes);

    return sql;
  },

  bulkInsertQuery: function(tableName, attrValueHashes, options, modelAttributes) {
    var query = 'INSERT<%= ignoreDuplicates %> INTO <%= table %> (<%= attributes %>) VALUES <%= tuples %>;'
      , tuples = []
      , allAttributes = [];

    _.forEach(attrValueHashes, function(attrValueHash) {
      _.forOwn(attrValueHash, function(value, key) {
        if (allAttributes.indexOf(key) === -1) allAttributes.push(key);
      });
    });

    _.forEach(attrValueHashes, function(attrValueHash) {
      tuples.push('(' +
        allAttributes.map(function (key) {
          return this.escape(attrValueHash[key], modelAttributes && modelAttributes[key]);
        }.bind(this)).join(',') +
      ')');
    }.bind(this));

    var replacements  = {
      ignoreDuplicates: options && options.ignoreDuplicates ? ' OR IGNORE' : '',
      table: this.quoteTable(tableName),
      attributes: allAttributes.map(function(attr) {
                    return this.quoteIdentifier(attr);
                  }.bind(this)).join(','),
      tuples: tuples
    };

    return _.template(query)(replacements);
  },

  updateQuery: function(tableName, attrValueHash, where, options, modelAttributes) {
    options = options || {};
    _.defaults(options, this.options);

    attrValueHash = Utils.removeNullValuesFromHash(attrValueHash, options.omitNull, options);

    var query  = 'UPDATE <%= table %> SET <%= values %> <%= where %>'
      , values = [];

    for (var key in attrValueHash) {
      values.push(this.quoteIdentifier(key) + '=' + this.escape(attrValueHash[key], modelAttributes && modelAttributes[key]));
    }

    var replacements = {
      table: this.quoteTable(tableName),
      values: values.join(','),
      where: this.whereQuery(where)
    };

    return _.template(query)(replacements).trim();
  },

  deleteQuery: function(tableName, where, options) {
    options = options || {};

    var query = 'DELETE FROM <%= table %><%= where %>';
    var replacements = {
      table: this.quoteTable(tableName),
      where: this.getWhereConditions(where)
    };

    if (replacements.where) {
      replacements.where = ' WHERE ' + replacements.where;
    }

    return _.template(query)(replacements);
  },

  attributesToSQL: function(attributes) {
    var result = {};

    for (var name in attributes) {
      var dataType = attributes[name];
      var fieldName = dataType.field || name;

      if (_.isObject(dataType)) {
        var template     = '<%= type %>'
          , replacements = { type: dataType.type };

        if (dataType.type instanceof DataTypes.ENUM) {
          replacements.type = 'VARCHAR2(255)';

          if (!(Array.isArray(dataType.values) && (dataType.values.length > 0))) {
            throw new Error("Values for ENUM haven't been defined.");
          }

          template += ' CHECK (' + this.quoteIdentifier(fieldName) + ' IN(' + _.map(dataType.values, function(value) {
            return this.escape(value);
          }.bind(this)).join(', ') + '))';
        }

        if (dataType.hasOwnProperty('allowNull') && !dataType.allowNull) {
          template += ' NOT NULL';
        }

        if (Utils.defaultValueSchemable(dataType.defaultValue)) {
          // TODO thoroughly check that DataTypes.NOW will properly
          // get populated on all databases as DEFAULT value
          // i.e. mysql requires: DEFAULT CURRENT_TIMESTAMP
          template += ' DEFAULT <%= defaultValue %>';
          replacements.defaultValue = this.escape(dataType.defaultValue);
        }

        if (dataType.unique === true) {
          template += ' UNIQUE';
        }

        if (dataType.primaryKey) {
          template += ' PRIMARY KEY';

          if (dataType.autoIncrement) {
            template += ' ';
          }
        }

        if(dataType.references) {
          dataType = Utils.formatReferences(dataType);
          template += ' REFERENCES <%= referencesTable %> (<%= referencesKey %>)';
          replacements.referencesTable = this.quoteTable(dataType.references.model);

          if(dataType.references.key) {
            replacements.referencesKey = this.quoteIdentifier(dataType.references.key);
          } else {
            replacements.referencesKey = this.quoteIdentifier('id');
          }

          if(dataType.onDelete) {
            template += ' ON DELETE <%= onDeleteAction %>';
            replacements.onDeleteAction = dataType.onDelete.toUpperCase();
          }

          // Oracle does not support ON UPDATE
          // if(dataType.onUpdate) {
          //   template += ' ON UPDATE <%= onUpdateAction %>';
          //   replacements.onUpdateAction = dataType.onUpdate.toUpperCase();
          // }

        }

        result[fieldName] = _.template(template)(replacements);
      } else {
        result[fieldName] = dataType;
      }
    }

    return result;
  },

  findAutoIncrementField: function(factory) {
    var fields = [];

    for (var name in factory.attributes) {
      if (factory.attributes.hasOwnProperty(name)) {
        var definition = factory.attributes[name];
        if (definition && definition.autoIncrement) {
          fields.push(name);
        }
      }
    }

    return fields;
  },

  showIndexesQuery: function(tableName) {
    return 'SELECT INDEX_NAME FROM USER_INDEXES WHERE TABLE_NAME = ' + wrapSingleQuote(tableName);
  },

  removeIndexQuery: function(tableName, indexNameOrAttributes) {
    var sql = 'DROP INDEX IF EXISTS <%= indexName %>'
      , indexName = indexNameOrAttributes;

    if (typeof indexName !== 'string') {
      indexName = Utils.inflection.underscore(tableName + '_' + indexNameOrAttributes.join('_'));
    }

    return _.template(sql)( { tableName: this.quoteIdentifiers(tableName), indexName: indexName });
  },

  describeTableQuery: function(tableName, schema, schemaDelimiter) {
    var options = {};
    options.schema = schema;
    options.schemaDelimiter = schemaDelimiter;
    options.quoted = false;

    var sql = 'PRAGMA TABLE_INFO(<%= tableName %>);';
    return _.template(sql)({ tableName: this.addSchema({tableName: this.quoteIdentifiers(tableName), options: options})});
  },

  removeColumnQuery: function(tableName, attributeName) {
    var query = 'ALTER TABLE <%= tableName %> DROP COLUMN <%= attributeName %>;';
    return _.template(query)({
      tableName: this.quoteTable(tableName),
      attributeName: this.quoteIdentifier(attributeName)
    });
  },

  renameColumnQuery: function(tableName, attrBefore, attributes) {
    var query = 'ALTER TABLE <%= tableName %> RENAME COLUMN <%= attributes %>;';
    var attrString = [];

    for (var attributeName in attributes) {
      attrString.push(_.template('<%= before %> TO <%= after %>')({
        before: this.quoteIdentifier(attrBefore),
        after: this.quoteIdentifier(attributeName)
      }));
    }

    return _.template(query)({
      tableName: this.quoteTable(tableName),
      attributes: attrString.join(', ')
    });
  },


  startTransactionQuery: function(transaction, options) {
    if (options.parent) {
      return 'SAVEPOINT ' + this.quoteIdentifier(transaction.name) + ';';
    }

    return 'SET TRANSACTION NAME ' + this.quoteIdentifier(transaction.name) + ';';
  },

  setAutocommitQuery: function() {
    return 'SET AUTOCOMMIT ON;';
  },

  setIsolationLevelQuery: function(value) {
    switch (value) {
      case Transaction.ISOLATION_LEVELS.REPEATABLE_READ:
        return '-- SQLite is not able to choose the isolation level REPEATABLE READ.';
      case Transaction.ISOLATION_LEVELS.READ_UNCOMMITTED:
        return 'PRAGMA read_uncommitted = ON;';
      case Transaction.ISOLATION_LEVELS.READ_COMMITTED:
        return 'PRAGMA read_uncommitted = OFF;';
      case Transaction.ISOLATION_LEVELS.SERIALIZABLE:
        return "-- SQLite's default isolation level is SERIALIZABLE. Nothing to do.";
      default:
        throw new Error('Unknown isolation level: ' + value);
    }
  },

  replaceBooleanDefaults: function(sql) {
    return sql.replace(/DEFAULT '?false'?/g, 'DEFAULT 0').replace(/DEFAULT '?true'?/g, 'DEFAULT 1');
  },

  quoteIdentifier: function(identifier) {
    if (identifier === '*') return identifier;
    return Utils.addTicks(identifier, '"');
  },

      /**
   * Generates an SQL query that returns all foreign keys of a table.
   *
   * @param  {String} tableName  The name of the table.
   * @param  {String} schemaName The name of the schema.
   * @return {String}            The generated sql query.
   */
  getForeignKeysQuery: function(tableName, schemaName) {
    var sql = 'PRAGMA foreign_key_list(<%= tableName %>)';
    return _.template(sql)({ tableName: tableName });
  }
};

// private methods
function wrapSingleQuote(identifier){
  return Utils.addTicks(identifier, "'");
}

module.exports = _.extend({}, OracleQueryGenerator, QueryGenerator);