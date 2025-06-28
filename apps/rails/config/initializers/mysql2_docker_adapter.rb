require_relative '../../lib/active_record/connection_adapters/mysql2_docker_adapter'

module ActiveRecord
  module ConnectionHandling
    def mysql2_docker_connection(config)
      config = config.symbolize_keys
      
      # Create a dummy connection object
      connection = Object.new
      
      ConnectionAdapters::Mysql2DockerAdapter.new(
        connection, 
        ActiveRecord::Base.logger, 
        {}, 
        config
      )
    end
  end
end

# Ensure the adapter is registered
ActiveRecord::ConnectionAdapters::Mysql2DockerAdapter
