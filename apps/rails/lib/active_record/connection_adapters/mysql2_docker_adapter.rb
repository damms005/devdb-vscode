require 'active_record'
require 'active_record/connection_adapters/abstract_adapter'

module ActiveRecord
  module ConnectionAdapters
    class Mysql2DockerAdapter < AbstractAdapter
      ADAPTER_NAME = 'mysql2_docker'.freeze

      def initialize(connection, logger, connection_options, config)
        super(connection, logger, config)
        @connection_options = connection_options
        @config = config
        @container_name = config[:container_name] || 'mysql-devdb-triage'
      end

      def self.database_exists?(config)
        container_name = config[:container_name] || 'mysql-devdb-triage'
        cmd = "docker exec #{container_name} mysql -h127.0.0.1 -u#{config[:username]} -p#{config[:password]} -e \"SHOW DATABASES LIKE '#{config[:database]}';\" -N"
        result = `#{cmd}`.strip
        !result.empty?
      end

      def execute(sql, name = nil)
        cmd = "docker exec #{@container_name} mysql -h127.0.0.1 -u#{@config[:username]} -p#{@config[:password]} #{@config[:database]} -e \"#{sql.gsub('"', '\\"')}\" -N"
        result = `#{cmd}`
        
        # Create a simple result object
        ActiveRecord::Result.new([], [])
      end

      def exec_query(sql, name = 'SQL', binds = [], prepare: false)
        cmd = "docker exec #{@container_name} mysql -h127.0.0.1 -u#{@config[:username]} -p#{@config[:password]} #{@config[:database]} -e \"#{sql.gsub('"', '\\"')}\" -N"
        result = `#{cmd}`
        
        # Create a simple result object
        ActiveRecord::Result.new([], [])
      end

      def create_database(name, options = {})
        cmd = "docker exec #{@container_name} mysql -h127.0.0.1 -u#{@config[:username]} -p#{@config[:password]} -e \"CREATE DATABASE IF NOT EXISTS #{name};\""
        system(cmd)
      end

      def drop_database(name)
        cmd = "docker exec #{@container_name} mysql -h127.0.0.1 -u#{@config[:username]} -p#{@config[:password]} -e \"DROP DATABASE IF EXISTS #{name};\""
        system(cmd)
      end

      def disconnect!
        # No connection to close
      end

      def reconnect!
        # No connection to reconnect
      end

      def supports_migrations?
        true
      end

      def supports_primary_key?
        true
      end

      def supports_ddl_transactions?
        true
      end

      def active?
        true
      end
    end
  end
end

# Register our adapter
ActiveRecord::ConnectionAdapters::Mysql2DockerAdapter
